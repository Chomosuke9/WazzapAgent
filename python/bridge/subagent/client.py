from __future__ import annotations

import asyncio
import base64
from collections import Counter
import hashlib
import os
import time
import uuid

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
  SUBAGENT_STEER_CONSUME_TIMEOUT_S,
  SUBAGENT_MAX_INLINE_FILE_BYTES,
  SUBAGENT_MAX_INLINE_TOTAL_BYTES,
  subagent_api_token_env,
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


class SubAgentSteerError(SubAgentSubmitError):
  """Raised when steering was not staged or consumed reliably."""


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
  ) -> dict:
    """Send a steering instruction to a running sub-agent via POST /steer.

    When ``input_files`` is provided, the files are shipped to the running
    session the same way :meth:`submit` ships them at task start: by path
    (single-machine) and base64-inlined under ``input_files_content``
    (cross-machine). The service re-stages them into the live session's
    workdir and tells the agent about them. Without this, files referenced
    mid-task would be silently dropped (only the instruction text reached
    the sub-agent).

    Returns the receiver receipt only after every requested file is checksum-
    acknowledged and the steering status becomes ``consumed``. Raises
    :class:`SubAgentSteerError` on staging, delivery, or consumption failure.
    """
    url = f"{self._base_url}/steer"
    steering_id = uuid.uuid4().hex
    payload: dict = {
      "session_id": session_id,
      "steering_id": steering_id,
      "instruction": instruction,
    }
    expected_manifest = self._expected_input_manifest(input_files or [])
    if input_files:
      try:
        wire_files, inline_files = await self._prepare_input_transfer(
          input_files,
          expected_manifest,
        )
      except SubAgentSubmitError as exc:
        raise SubAgentSteerError(
          str(exc), status_code=exc.status_code, body=exc.body,
        ) from exc
      payload["input_files"] = wire_files
      payload["input_files_content"] = inline_files

    attempts = max(1, SUBAGENT_SUBMIT_RETRY_MAX + 1)
    body: dict = {}
    for attempt in range(1, attempts + 1):
      loop = asyncio.get_running_loop()
      try:
        body = await loop.run_in_executor(None, lambda: self._post_sync(url, payload))
      except Exception as exc:
        if attempt >= attempts:
          raise SubAgentSteerError(
            f"Failed to reach SubAgent steering endpoint after {attempts} attempts: {exc}"
          ) from exc
        await asyncio.sleep(_backoff_seconds(attempt))
        continue
      status = body.get("_status_code")
      if isinstance(status, int) and 200 <= status < 300:
        self._validate_staging_ack(
          body,
          expected_manifest,
          operation="/steer",
          session_id=session_id,
        )
        returned_id = str(body.get("steering_id") or "")
        if returned_id != steering_id:
          raise SubAgentSteerError(
            "SubAgent /steer returned a mismatched steering_id",
            status_code=status,
            body=body,
          )
        consumed = await self._wait_for_steering_consumed(session_id, steering_id)
        body["consume_status"] = consumed
        logger.info(
          "steer: instruction consumed by running sub-agent session=%s steering=%s",
          session_id,
          steering_id,
          extra={"session_id": session_id, "instruction_preview": instruction[:200]},
        )
        return body
      retryable = isinstance(status, int) and (status == 429 or 500 <= status < 600)
      if not retryable or attempt >= attempts:
        raise SubAgentSteerError(
          f"SubAgent /steer returned status={status}",
          status_code=status if isinstance(status, int) else None,
          body=body,
        )
      await asyncio.sleep(_backoff_seconds(attempt, body=body))
    raise SubAgentSteerError("SubAgent steering retry loop exhausted", body=body)

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
    expected_manifest = self._expected_input_manifest(input_files)
    wire_files, inline_files = await self._prepare_input_transfer(
      input_files,
      expected_manifest,
    )
    payload["input_files"] = wire_files
    payload["input_files_content"] = inline_files
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
        try:
          self._validate_staging_ack(
            body,
            expected_manifest,
            operation="/execute",
            session_id=session_id,
          )
        except SubAgentSubmitError:
          if body.get("idempotent_replay") is True and attempt < attempts:
            await asyncio.sleep(_backoff_seconds(attempt, body=body))
            continue
          raise
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
    auth = self._auth_headers()
    kwargs = {"headers": auth} if auth else {}
    resp = requests.post(
      url, json=payload, timeout=SUBAGENT_HTTP_TIMEOUT, **kwargs,
    )
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

  def _get_sync(self, url: str) -> dict:
    if requests is None:
      raise RuntimeError("requests library is not installed")
    auth = self._auth_headers()
    kwargs = {"headers": auth} if auth else {}
    resp = requests.get(url, timeout=SUBAGENT_HTTP_TIMEOUT, **kwargs)
    try:
      body = resp.json()
    except Exception:
      body = {"text": resp.text}
    body["_status_code"] = resp.status_code
    return body

  @staticmethod
  def _auth_headers() -> dict[str, str]:
    token = subagent_api_token_env()
    return {"Authorization": f"Bearer {token}"} if token else {}

  async def _prepare_input_transfer(
    self,
    input_files: list[str],
    expected_manifest: list[dict],
  ) -> tuple[list[object], list[dict]]:
    """Inline small inputs and resumably upload everything else.

    Path-only fallback is deliberately not used for omitted inline files: it
    works only on a shared filesystem and was the source of silent cross-machine
    losses. Uploaded entries are checksum-bound and later acknowledged again by
    ``/execute`` or ``/steer``.
    """
    inline_files = self._encode_input_files(input_files)
    inline_identities = Counter(
      (
        str(item.get("name") or ""),
        item.get("size"),
        str(item.get("sha256") or ""),
      )
      for item in inline_files
    )
    wire_files: list[object] = []
    loop = asyncio.get_running_loop()
    for path, identity in zip(input_files, expected_manifest, strict=True):
      key = (identity["name"], identity["size"], identity["sha256"])
      if inline_identities[key] > 0:
        inline_identities[key] -= 1
        # Keep the legacy path alongside inline content. The receiver selects
        # the verified inline bytes first and shared-filesystem deployments stay
        # backward compatible.
        wire_files.append(path)
        continue
      uploaded = await loop.run_in_executor(
        None,
        lambda p=path, meta=identity: self._upload_file_sync(p, meta),
      )
      wire_files.append(uploaded)
    return wire_files, inline_files

  def _upload_file_sync(self, path: str, identity: dict) -> dict:
    """Upload one file with idempotent chunks and end-to-end SHA validation."""
    upload_id = uuid.uuid4().hex
    filename = str(identity["name"])
    expected_size = int(identity["size"])
    expected_sha = str(identity["sha256"])
    init_body = self._upload_request_sync(
      "post",
      f"{self._base_url}/uploads/init",
      json_body={
        "upload_id": upload_id,
        "filename": filename,
        "size": expected_size,
        "sha256": expected_sha,
      },
    )
    self._validate_upload_identity(init_body, upload_id, identity, complete=False)
    try:
      server_chunk_size = int(init_body.get("max_chunk_bytes") or 0)
    except (TypeError, ValueError) as exc:
      raise SubAgentSubmitError(
        "SubAgent upload init returned invalid max_chunk_bytes", body=init_body,
      ) from exc
    if server_chunk_size <= 0:
      raise SubAgentSubmitError(
        "SubAgent upload init returned invalid max_chunk_bytes", body=init_body,
      )
    # Bound local memory even if a misconfigured/malicious receiver advertises
    # an enormous chunk size.
    chunk_size = min(server_chunk_size, 8 * 1024 * 1024)
    offset = 0
    index = 0
    try:
      with open(path, "rb") as handle:
        while offset < expected_size:
          data = handle.read(min(chunk_size, expected_size - offset))
          if not data:
            raise SubAgentSubmitError(
              f"input file changed/truncated during upload: {path}"
            )
          end = offset + len(data) - 1
          chunk_sha = hashlib.sha256(data).hexdigest()
          chunk_body = self._upload_request_sync(
            "put",
            f"{self._base_url}/uploads/{upload_id}/chunks/{index}",
            raw_body=data,
            extra_headers={
              "Content-Range": f"bytes {offset}-{end}/{expected_size}",
              "Content-Type": "application/octet-stream",
            },
          )
          chunk = chunk_body.get("chunk")
          if (
            not isinstance(chunk, dict)
            or chunk.get("index") != index
            or chunk.get("start") != offset
            or chunk.get("end") != end
            or chunk.get("size") != len(data)
            or str(chunk.get("sha256") or "") != chunk_sha
          ):
            raise SubAgentSubmitError(
              "SubAgent upload returned a mismatched chunk receipt",
              status_code=chunk_body.get("_status_code"),
              body=chunk_body,
            )
          offset = end + 1
          index += 1
        if handle.read(1):
          raise SubAgentSubmitError(f"input file grew during upload: {path}")
    except OSError as exc:
      raise SubAgentSubmitError(f"failed reading input file {path}: {exc}") from exc
    complete_body = self._upload_request_sync(
      "post",
      f"{self._base_url}/uploads/{upload_id}/complete",
    )
    self._validate_upload_identity(
      complete_body, upload_id, identity, complete=True,
    )
    return {
      "upload_id": upload_id,
      "name": filename,
      "size": expected_size,
      "sha256": expected_sha,
    }

  def _upload_request_sync(
    self,
    method: str,
    url: str,
    *,
    json_body: dict | None = None,
    raw_body: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
  ) -> dict:
    if requests is None:
      raise SubAgentSubmitError("requests library is not installed")
    attempts = max(1, SUBAGENT_SUBMIT_RETRY_MAX + 1)
    last_body: dict = {}
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
      headers = self._auth_headers()
      headers.update(extra_headers or {})
      kwargs: dict = {
        "timeout": SUBAGENT_HTTP_TIMEOUT,
        "headers": headers,
      }
      if json_body is not None:
        kwargs["json"] = json_body
      if raw_body is not None:
        kwargs["data"] = raw_body
      try:
        request_fn = getattr(requests, method)
        response = request_fn(url, **kwargs)
        try:
          body = response.json()
          if not isinstance(body, dict):
            body = {"response": body}
        except Exception:
          body = {"text": response.text}
        body["_status_code"] = response.status_code
        last_body = body
        if 200 <= response.status_code < 300 and body.get("success") is True:
          return body
        retryable = response.status_code == 429 or response.status_code >= 500
        if not retryable or attempt >= attempts:
          raise SubAgentSubmitError(
            f"SubAgent upload returned status={response.status_code}",
            status_code=response.status_code,
            body=body,
          )
      except SubAgentSubmitError:
        raise
      except Exception as exc:  # network failure
        last_error = exc
        if attempt >= attempts:
          raise SubAgentSubmitError(
            f"SubAgent upload request failed after {attempts} attempts: {exc}",
            body=last_body,
          ) from exc
      time.sleep(_backoff_seconds(attempt, body=last_body))
    raise SubAgentSubmitError(
      f"SubAgent upload retry loop exhausted (last_err={last_error})",
      body=last_body,
    )

  @staticmethod
  def _validate_upload_identity(
    body: dict,
    upload_id: str,
    expected: dict,
    *,
    complete: bool,
  ) -> None:
    if (
      str(body.get("upload_id") or "") != upload_id
      or str(body.get("filename") or "") != str(expected["name"])
      or body.get("size") != expected["size"]
      or str(body.get("sha256") or "") != str(expected["sha256"])
      or (complete and body.get("complete") is not True)
      or (complete and body.get("state") != "complete")
    ):
      raise SubAgentSubmitError(
        "SubAgent upload returned a mismatched identity receipt",
        status_code=body.get("_status_code"),
        body=body,
      )

  async def _wait_for_steering_consumed(
    self,
    session_id: str,
    steering_id: str,
  ) -> dict:
    url = f"{self._base_url}/sessions/{session_id}/steering/{steering_id}"
    deadline = time.monotonic() + max(1.0, float(SUBAGENT_STEER_CONSUME_TIMEOUT_S))
    last_body: dict = {}
    while time.monotonic() < deadline:
      loop = asyncio.get_running_loop()
      try:
        body = await loop.run_in_executor(None, lambda: self._get_sync(url))
      except Exception as exc:
        last_body = {"error": str(exc)}
        await asyncio.sleep(0.25)
        continue
      last_body = body
      status = body.get("_status_code")
      state = body.get("state")
      if status == 200 and state == "consumed":
        return body
      if status == 200 and state == "queued":
        await asyncio.sleep(0.25)
        continue
      if isinstance(status, int) and status >= 500:
        await asyncio.sleep(0.25)
        continue
      raise SubAgentSteerError(
        f"SubAgent steering status failed status={status} state={state}",
        status_code=status if isinstance(status, int) else None,
        body=body,
      )
    raise SubAgentSteerError(
      "SubAgent accepted steering but did not consume it before the timeout",
      body=last_body,
    )

  def _expected_input_manifest(self, input_files: list[str]) -> list[dict]:
    """Build a strict local identity manifest for every requested file."""
    result: list[dict] = []
    for path in input_files:
      if not os.path.isfile(path):
        raise SubAgentSubmitError(f"input file is missing or not regular: {path}")
      digest = hashlib.sha256()
      size = 0
      try:
        with open(path, "rb") as fh:
          while True:
            chunk = fh.read(1024 * 1024)
            if not chunk:
              break
            size += len(chunk)
            digest.update(chunk)
      except OSError as exc:
        raise SubAgentSubmitError(f"failed reading input file {path}: {exc}") from exc
      result.append({
        "name": os.path.basename(path),
        "size": size,
        "sha256": digest.hexdigest(),
      })
    return result

  def _validate_staging_ack(
    self,
    body: dict,
    expected: list[dict],
    *,
    operation: str,
    session_id: str,
  ) -> None:
    """Require an exact receiver-side count and SHA-256 manifest match."""
    status = body.get("_status_code")
    error_type = SubAgentSteerError if operation == "/steer" else SubAgentSubmitError
    if body.get("accepted") is not True:
      raise error_type(
        f"SubAgent {operation} did not explicitly accept the request",
        status_code=status if isinstance(status, int) else None,
        body=body,
      )
    returned_session = str(body.get("session_id") or "")
    if returned_session != session_id:
      raise error_type(
        f"SubAgent {operation} returned a mismatched session_id",
        status_code=status if isinstance(status, int) else None,
        body=body,
      )
    if operation == "/execute":
      if body.get("status") not in {"processing", "completed"} or not str(body.get("request_fingerprint") or ""):
        raise error_type(
          "SubAgent /execute returned an incomplete acceptance receipt",
          status_code=status if isinstance(status, int) else None,
          body=body,
        )
    elif body.get("state") not in {"queued", "consumed"}:
      raise error_type(
        "SubAgent /steer did not confirm that steering was queued",
        status_code=status if isinstance(status, int) else None,
        body=body,
      )
    requested_count = body.get("requested_file_count")
    staged_count = body.get("staged_file_count")
    staged_files = body.get("staged_files")
    file_errors = body.get("file_errors")
    if (
      requested_count != len(expected)
      or staged_count != len(expected)
      or not isinstance(staged_files, list)
      or len(staged_files) != len(expected)
      or file_errors not in ([], None)
    ):
      raise error_type(
        f"SubAgent {operation} staged only part of the requested input",
        status_code=status if isinstance(status, int) else None,
        body=body,
      )
    expected_ids = Counter((item["sha256"], item["size"]) for item in expected)
    actual_ids = Counter()
    for item in staged_files:
      if not isinstance(item, dict):
        raise error_type(
          f"SubAgent {operation} returned an invalid staged file manifest",
          status_code=status if isinstance(status, int) else None,
          body=body,
        )
      actual_ids[(str(item.get("sha256") or ""), item.get("size"))] += 1
    if actual_ids != expected_ids:
      raise error_type(
        f"SubAgent {operation} staged file checksum/size mismatch",
        status_code=status if isinstance(status, int) else None,
        body=body,
      )

  def _encode_input_files(self, input_files: list[str]) -> list[dict]:
    """Base64-encode input files for cross-machine transfer.

    For each path in input_files: if the file exists and its size is within
    SUBAGENT_MAX_INLINE_FILE_BYTES, read and base64-encode its bytes.
    Returns a list of verified identity-bearing inline entries. Files omitted
    because of per-file or aggregate limits are transferred by the resumable
    upload protocol before the task request is submitted.
    """
    result: list[dict] = []
    total_encoded_bytes = 0
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
        if total_encoded_bytes + size > SUBAGENT_MAX_INLINE_TOTAL_BYTES:
          logger.info(
            "omitting %s from input_files_content: aggregate inline limit %d would be exceeded",
            os.path.basename(path),
            SUBAGENT_MAX_INLINE_TOTAL_BYTES,
          )
          continue
        with open(path, "rb") as fh:
          data = fh.read()
        result.append({
          "name": os.path.basename(path),
          "content_base64": base64.b64encode(data).decode("ascii"),
          "size": len(data),
          "sha256": hashlib.sha256(data).hexdigest(),
        })
        total_encoded_bytes += size
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
