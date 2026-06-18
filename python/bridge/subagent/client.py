from __future__ import annotations

import asyncio
import base64
import os

try:
  import requests
except ImportError:
  requests = None  # type: ignore

from ..log import setup_logging

logger = setup_logging()

from .config import (
  SUBAGENT_URL,
  SUBAGENT_WEBHOOK_URL,
  SUBAGENT_SUBMIT_RETRY_MAX,
  SUBAGENT_SUBMIT_RETRY_BASE_BACKOFF,
  SUBAGENT_SUBMIT_RETRY_MAX_BACKOFF,
  SUBAGENT_HTTP_TIMEOUT,
  SUBAGENT_MAX_INLINE_FILE_BYTES,
)


class SubAgentSubmitError(RuntimeError):
  """Raised when /execute fails after retries.

  Carries ``status_code`` (HTTP status of the last response, if any) and
  ``body`` (raw JSON or text from the SubAgent) so callers can log and
  surface a clean error to the user instead of waiting indefinitely on a
  webhook that will never arrive.
  """

  def __init__(self, message: str, status_code: int | None = None, body: dict | None = None) -> None:
    super().__init__(message)
    self.status_code = status_code
    self.body = body or {}


class SubAgentClient:
  def __init__(
    self,
    base_url: str | None = None,
    webhook_url: str | None = None,
  ) -> None:
    self._base_url = (base_url or SUBAGENT_URL).rstrip("/")
    self._webhook_url = webhook_url or SUBAGENT_WEBHOOK_URL

  async def steer(
    self,
    session_id: str,
    instruction: str,
    input_files: list[str] | None = None,
  ) -> bool:
    """Send a steering instruction to a running sub-agent via POST /steer.

    When ``input_files`` is provided, the files are shipped to the running
    session the same way :meth:`submit` ships them at task start: by path
    (single-machine) and base64-inlined under ``input_files_content``
    (cross-machine). The service re-stages them into the live session's
    workdir and tells the agent about them. Without this, files referenced
    mid-task would be silently dropped (only the instruction text reached
    the sub-agent).

    Returns ``True`` if the steering was accepted by the remote (HTTP 200),
    ``False`` if the session was not found (HTTP 404) or any other error.
    Does NOT raise on failure — callers should log and move on.
    """
    url = f"{self._base_url}/steer"
    payload: dict = {"session_id": session_id, "instruction": instruction}
    if input_files:
      payload["input_files"] = input_files
      try:
        payload["input_files_content"] = self._encode_input_files(input_files)
      except Exception:  # encoding failure must never break steering
        payload["input_files_content"] = []
    loop = asyncio.get_running_loop()
    try:
      resp = await loop.run_in_executor(
        None, lambda: requests.post(url, json=payload, timeout=SUBAGENT_HTTP_TIMEOUT)
      )
      if resp.status_code == 200:
        logger.info(
          "steer: forwarded instruction to running sub-agent session=%s",
          session_id,
          extra={"session_id": session_id, "instruction_preview": instruction[:200]},
        )
        return True
      logger.warning(
        "steer: remote returned status=%d for session=%s",
        resp.status_code,
        session_id,
        extra={"session_id": session_id},
      )
      return False
    except Exception as exc:
      logger.warning(
        "steer: request failed for session=%s: %s",
        session_id,
        exc,
        extra={"session_id": session_id},
      )
      return False

  async def submit(
    self,
    session_id: str,
    instruction: str,
    input_files: list[str],
    *,
    high_quality: bool = False,
    previous_session_id: str | None = None,
  ) -> dict:
    """Submit a task to the SubAgent (non-blocking).

    Retries transient submit errors (network blip, 429, 5xx) with
    exponential backoff. Raises :class:`SubAgentSubmitError` on permanent
    failure or after all retries are exhausted, so the caller does not
    silently wait for a webhook that will never arrive.

    If *previous_session_id* is provided, the sub-agent will carry forward
    the conversation history from that session as context — used when LLM2
    re-dispatches a correction so the agent can continue where it left off.
    """
    # The webhook server dispatches on the JSON body's ``type`` field
    # (``complete`` vs ``progress``), not the URL — so callback_url and
    # progress_webhook point at the same endpoint. Sending them as the
    # exact same URL keeps the wire format simple and avoids confusing
    # ``?type=progress`` query strings that are never read.
    payload = {
      "session_id": session_id,
      "instruction": instruction,
      "input_files": input_files,
      "callback_url": self._webhook_url,
      "progress_webhook": self._webhook_url,
      "high_quality": high_quality,
    }
    if previous_session_id is not None:
      payload["previous_session_id"] = previous_session_id
    try:
      payload["input_files_content"] = self._encode_input_files(input_files)
    except Exception:  # encoding failure must never break submit
      payload["input_files_content"] = []
    url = f"{self._base_url}/execute"
    attempts = max(1, SUBAGENT_SUBMIT_RETRY_MAX + 1)
    last_status: int | None = None
    last_body: dict = {}
    last_err: Exception | None = None
    for attempt in range(1, attempts + 1):
      loop = asyncio.get_running_loop()
      try:
        body = await loop.run_in_executor(None, lambda: self._post_sync(url, payload))
      except Exception as err:  # network failure, JSON decode error, etc.
        last_err = err
        last_status = None
        last_body = {}
        if attempt >= attempts:
          raise SubAgentSubmitError(
            f"Failed to reach SubAgent at {url} after {attempts} attempts: {err}",
          ) from err
        await asyncio.sleep(_backoff_seconds(attempt))
        continue

      status = body.get("_status_code")
      last_status = status if isinstance(status, int) else None
      last_body = body
      if isinstance(status, int) and 200 <= status < 300:
        return body
      retryable = isinstance(status, int) and (status == 429 or 500 <= status < 600)
      if not retryable or attempt >= attempts:
        raise SubAgentSubmitError(
          f"SubAgent /execute returned status={status}",
          status_code=last_status,
          body=last_body,
        )
      await asyncio.sleep(_backoff_seconds(attempt, body=body))

    # Defensive — loop above should always either return or raise.
    raise SubAgentSubmitError(
      f"SubAgent submit loop exhausted without a result (last_err={last_err})",
      status_code=last_status,
      body=last_body,
    )

  def _post_sync(self, url: str, payload: dict) -> dict:
    if requests is None:
      raise RuntimeError("requests library is not installed")
    resp = requests.post(url, json=payload, timeout=SUBAGENT_HTTP_TIMEOUT)
    # Return response JSON if available; otherwise basic status info
    try:
      body = resp.json()
    except Exception:
      body = {"status_code": resp.status_code, "text": resp.text}
    body["_status_code"] = resp.status_code
    retry_after = resp.headers.get("Retry-After") if resp.headers else None
    if retry_after:
      body["_retry_after"] = retry_after
    return body

  def _encode_input_files(self, input_files: list[str]) -> list[dict]:
    """Base64-encode input files for cross-machine transfer.

    For each path in input_files: if the file exists and its size is within
    SUBAGENT_MAX_INLINE_FILE_BYTES, read and base64-encode its bytes.
    Returns a list of {name, content_base64} dicts. Entries that don't
    exist, aren't regular files, or exceed the size limit are silently
    skipped (they stay in input_files for the path-based fallback).
    """
    result: list[dict] = []
    for path in input_files:
      try:
        if not os.path.isfile(path):
          continue
        size = os.path.getsize(path)
        if size > SUBAGENT_MAX_INLINE_FILE_BYTES:
          logger.info(
            "omitting %s from input_files_content: size %d bytes exceeds inline limit %d",
            os.path.basename(path),
            size,
            SUBAGENT_MAX_INLINE_FILE_BYTES,
          )
          continue
        with open(path, "rb") as fh:
          data = fh.read()
        result.append({
          "name": os.path.basename(path),
          "content_base64": base64.b64encode(data).decode("ascii"),
        })
      except Exception:  # noqa: BLE001 — never let encoding break submit
        continue
    return result


def _backoff_seconds(attempt: int, *, body: dict | None = None) -> float:
  """Compute backoff before retry. Honours Retry-After when present."""
  if body is not None:
    raw = body.get("_retry_after")
    if isinstance(raw, str) and raw:
      try:
        return min(SUBAGENT_SUBMIT_RETRY_MAX_BACKOFF, max(0.0, float(raw)))
      except (TypeError, ValueError):
        pass
  exp = SUBAGENT_SUBMIT_RETRY_BASE_BACKOFF * (2 ** (attempt - 1))
  return min(SUBAGENT_SUBMIT_RETRY_MAX_BACKOFF, exp)