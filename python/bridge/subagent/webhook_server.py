from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urljoin, urlsplit
from typing import Awaitable, Callable, Dict, Optional, Tuple

try:
  from aiohttp import web
  import aiohttp
except ImportError:  # pragma: no cover - import-time guard
  # ``aiohttp`` is a hard requirement for the SubAgent webhook server
  # (declared in requirements.txt). The fallback below keeps the import
  # itself succeeding so that callers who never instantiate the webhook
  # server (e.g. unit tests that only touch other parts of the package)
  # don't blow up — but ``SubAgentWebhookServer.start`` raises loudly
  # if it's actually missing at runtime, instead of silently degrading
  # into a 120 s polling fallback for every sub-agent task.
  web = None  # type: ignore
  aiohttp = None  # type: ignore

from ..log import setup_logging
from .config import (
  SUBAGENT_OUTPUT_DOWNLOAD_TIMEOUT_S,
  SUBAGENT_URL,
  SUBAGENT_WEBHOOK_PORT,
  subagent_api_token_env,
  subagent_webhook_host_env,
  subagent_webhook_max_body_bytes_raw,
  subagent_webhook_token_env,
)
from .output import MAX_FILE_SIZE_BYTES
from .tracker import SubTaskTracker

logger = setup_logging()


QueueEventHandler = Callable[[str, str, int, int], Awaitable[None]]
# Signature: handler(chat_id, event_type, position, queue_size) -> awaitable
CompletionRecoveryHandler = Callable[[str, str], Awaitable[None]]
# Signature: handler(chat_id, session_id) -> awaitable


class _OutputDownloadError(RuntimeError):
  pass


class SubAgentWebhookServer:
  # Dedup window for queue webhooks: skip a (session_id, position,
  # queue_size) tuple if we've already dispatched the same triplet in
  # the last ``_QUEUE_DEDUP_WINDOW_S`` seconds. This is a belt-and-
  # braces guard against the sub-agent double-firing after a webhook
  # retry — we do NOT want the user to see "current queue: 1" twice
  # back-to-back.
  _QUEUE_DEDUP_WINDOW_S = 5.0

  # How long to wait between restart attempts when the persistent
  # runner catches an unexpected crash.
  _RESTART_DELAY_S = 2.0

  # How often (in seconds) the persistent keeper probes the /health
  # endpoint to detect a silently-dead aiohttp server.
  _HEALTH_CHECK_INTERVAL_S = 5.0

  def __init__(self, tracker: SubTaskTracker, port: int | None = None) -> None:
    self._tracker = tracker
    self._port = SUBAGENT_WEBHOOK_PORT if port is None else port
    self._bound_port = self._port
    self._completion_events: Dict[str, asyncio.Event] = {}
    self._waiter_owned_sessions: set[str] = set()
    # Keepalive events: set each time a progress webhook arrives so the
    # bridge can reset its per-batch timeout instead of treating a slow
    # but still-working sub-agent as dead.
    self._progress_events: Dict[str, asyncio.Event] = {}
    self._runner: web.AppRunner | None = None
    self._site: web.TCPSite | None = None
    self._queue_handler: Optional[QueueEventHandler] = None
    self._completion_recovery_handler: Optional[CompletionRecoveryHandler] = None
    # session_id -> (position, queue_size, last_emit_ts)
    self._queue_last_emit: Dict[str, Tuple[int, int, float]] = {}
    # Persistent-runner bookkeeping. ``_shutdown`` is set by
    # ``stop_persistent()`` to signal the graceful-shutdown path;
    # ``_keeper_task`` holds the always-on background task.
    self._shutdown = False
    self._keeper_task: asyncio.Task | None = None
    _raw = subagent_webhook_max_body_bytes_raw()
    try:
      self._client_max_size = int(_raw)
    except ValueError:
      raise ValueError(
        f"SUBAGENT_WEBHOOK_MAX_BODY_BYTES must be a plain integer number of bytes; "
        f"got {_raw!r}"
      ) from None

  async def start(self) -> None:
    """Start the webhook server once (no auto-restart).

    For production use prefer ``start_persistent()`` which wraps this
    with automatic restart on crashes so the webhook stays alive for
    the entire bridge lifetime.
    """
    if web is None:
      raise RuntimeError(
        "aiohttp is not installed but is required for the SubAgent webhook "
        "server. Install it via `pip install -r requirements.txt` (or "
        "`pip install aiohttp>=3.9.0`)."
      )
    if self._runner is not None or self._site is not None:
      return
    app = web.Application(client_max_size=self._client_max_size)
    app.router.add_post("/subagent/callback", self._handle_callback)
    app.router.add_get("/health", self._handle_health)
    runner = web.AppRunner(app)
    site: web.TCPSite | None = None
    host = subagent_webhook_host_env()
    try:
      is_loopback = host.lower() == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
      is_loopback = False
    if not is_loopback and subagent_webhook_token_env() is None:
      raise RuntimeError(
        "SUBAGENT_WEBHOOK_TOKEN is required when SUBAGENT_WEBHOOK_HOST "
        f"binds a non-loopback interface ({host!r})"
      )
    try:
      await runner.setup()
      site = web.TCPSite(runner, host, self._port)
      await site.start()
    except Exception:
      try:
        if site is not None:
          await site.stop()
      finally:
        await runner.cleanup()
      raise
    self._runner = runner
    self._site = site
    server = getattr(site, "_server", None)
    sockets = getattr(server, "sockets", None) or []
    if sockets:
      self._bound_port = int(sockets[0].getsockname()[1])
    logger.info("SubAgent webhook server started on %s:%s", host, self._bound_port)

  async def start_persistent(self) -> None:
    """Start the webhook server and keep it alive indefinitely.

    Spawns a background ``asyncio.Task`` that calls ``start()`` and
    automatically restarts the server if it ever crashes. This is the
    preferred entry point for production — the webhook server should
    **never** go down during normal operation, so any unexpected
    exception triggers a restart after a short delay.

    The keeper stops only when ``stop_persistent()`` is called, which
    signals a graceful shutdown.
    """
    if self._keeper_task is not None and not self._keeper_task.done():
      return
    self._shutdown = False

    # Gate bridge startup on a real successful bind.  Previously this method
    # returned immediately after spawning the keeper, so a port collision could
    # leave task submission enabled while the callback server retried forever.
    await self.start()

    async def _keeper() -> None:
      """Probe the live server and recover after post-start failures."""
      attempt = 0
      while not self._shutdown:
        await asyncio.sleep(self._HEALTH_CHECK_INTERVAL_S)
        if self._shutdown:
          break
        if await self._check_health():
          attempt = 0
          continue
        logger.warning("SubAgent webhook server health check failed; restarting")
        await self._do_stop()
        while not self._shutdown:
          try:
            await self.start()
            attempt = 0
            break
          except Exception as exc:  # pylint: disable=broad-except
            attempt += 1
            logger.error(
              "SubAgent webhook restart failed (attempt %d); retrying in %ds: %s",
              attempt,
              self._RESTART_DELAY_S,
              exc,
            )
            await self._do_stop()
            await asyncio.sleep(self._RESTART_DELAY_S)

    self._keeper_task = asyncio.create_task(_keeper())

  async def stop(self) -> None:
    """Stop the webhook server (one-shot, for ``start()``)."""
    await self._do_stop()

  async def stop_persistent(self) -> None:
    """Signal the persistent keeper to stop and wait for it to finish.

    Safe to call even if ``start_persistent()`` was never invoked —
    the method is a no-op in that case.
    """
    self._shutdown = True
    if self._keeper_task is not None:
      self._keeper_task.cancel()
      try:
        await self._keeper_task
      except asyncio.CancelledError:
        pass
      self._keeper_task = None
    await self._do_stop()

  async def _check_health(self) -> bool:
    """Probe the webhook's own /health endpoint.

    Returns True if the server responds with 200, False otherwise.
    Used by the persistent keeper to detect a silently-dead server.
    """
    if aiohttp is None:
      return True  # can't check without aiohttp; assume ok
    url = f"http://127.0.0.1:{self._bound_port}/health"
    try:
      async with aiohttp.ClientSession() as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
          return resp.status == 200
    except Exception:
      return False

  async def _do_stop(self) -> None:
    """Internal cleanup: stop the site and runner if they exist."""
    site, runner = self._site, self._runner
    self._site = None
    self._runner = None
    try:
      if site is not None:
        await site.stop()
    finally:
      if runner is not None:
        await runner.cleanup()

  def register_completion_event(self, session_id: str, event: asyncio.Event) -> None:
    self._completion_events[session_id] = event
    self._waiter_owned_sessions.add(session_id)
    # A callback may have raced registration and been replayed by the durable
    # tracker. Do not make the coordinator wait for a second callback.
    if self._tracker.is_finished(session_id):
      event.set()

  def unregister_completion_event(self, session_id: str) -> None:
    """Remove completion event to prevent memory leak."""
    self._completion_events.pop(session_id, None)
    self._waiter_owned_sessions.discard(session_id)

  def register_progress_event(self, session_id: str, event: asyncio.Event) -> None:
    """Register a keepalive event for *session_id* that is set each time a
    progress webhook arrives. The bridge waits on this alongside the
    completion event so it can reset the timeout when the sub-agent is
    still alive."""
    self._progress_events[session_id] = event

  def unregister_progress_event(self, session_id: str) -> None:
    """Remove keepalive event to prevent memory leak."""
    self._progress_events.pop(session_id, None)

  def set_queue_handler(self, handler: Optional[QueueEventHandler]) -> None:
    """Register (or clear, with ``None``) the async handler invoked for
    every ``queued`` / ``queue_advanced`` webhook from WazzapSubAgents.

    Registered by ``main.py::handle_socket`` so the handler closes over
    the live ``ws`` connection. Cleared when the gateway disconnects so
    a stale ws is never written to.
    """
    self._queue_handler = handler

  def set_completion_recovery_handler(
    self, handler: Optional[CompletionRecoveryHandler],
  ) -> None:
    """Set the fallback used for results whose original waiter died on restart."""
    self._completion_recovery_handler = handler

  def clear_completion_recovery_handler_if(
    self, handler: CompletionRecoveryHandler,
  ) -> bool:
    if self._completion_recovery_handler is handler:
      self._completion_recovery_handler = None
      return True
    return False

  def clear_queue_handler_if(self, handler: QueueEventHandler) -> bool:
    """Clear the queue handler only if it is identically ``handler``.

    The webhook server is a process-wide singleton but ``handle_socket``
    is spawned once per gateway connection. Without this guard, an
    older connection finishing its ``finally`` block could wipe out
    the newer connection's handler — silencing every subsequent queue
    notification. ``handle_socket`` therefore passes its own closure
    here so we only clear if it is still the live one. Returns True
    if cleared, False if a different (or no) handler was current.
    """
    if self._queue_handler is handler:
      self._queue_handler = None
      return True
    return False

  def _is_duplicate_queue_event(self, session_id: str, position: int, queue_size: int) -> bool:
    """Pure read-only check: is this (session_id, position, queue_size)
    a dup of one we *successfully delivered* within the last
    ``_QUEUE_DEDUP_WINDOW_S`` seconds?

    Recording the emit is deliberately split out (see
    :meth:`_record_queue_emit`) so we only suppress a retry when the
    previous attempt actually reached the gateway. Otherwise a handler
    failure followed by a sub-agent retry would silently lose the
    notification.
    """
    prev = self._queue_last_emit.get(session_id)
    if prev is None:
      return False
    prev_pos, prev_qs, prev_ts = prev
    return (
      prev_pos == position
      and prev_qs == queue_size
      and (time.time() - prev_ts) < self._QUEUE_DEDUP_WINDOW_S
    )

  def _record_queue_emit(self, session_id: str, position: int, queue_size: int) -> None:
    """Record a successful emit so subsequent retries within the dedup
    window are suppressed. Must be called *after* the handler returns
    cleanly — never before."""
    self._queue_last_emit[session_id] = (position, queue_size, time.time())

  @staticmethod
  def _provided_token(request: web.Request) -> str:
    headers = getattr(request, "headers", {}) or {}
    direct = headers.get("X-Subagent-Webhook-Token", "")
    if direct:
      return str(direct)
    authorization = str(headers.get("Authorization", ""))
    if authorization.lower().startswith("bearer "):
      return authorization[7:].strip()
    return ""

  def _is_authorized(self, request: web.Request) -> bool:
    expected = subagent_webhook_token_env()
    if expected is None:
      return True
    provided = self._provided_token(request)
    return bool(provided) and secrets.compare_digest(provided, expected)

  @staticmethod
  def _origin(url: str) -> tuple[str, str, int | None]:
    parts = urlsplit(url)
    scheme = parts.scheme.lower()
    port = parts.port
    if port is None:
      port = 443 if scheme == "https" else 80 if scheme == "http" else None
    return scheme, (parts.hostname or "").lower(), port

  @staticmethod
  def _existing_download_matches(path, expected_size: int, expected_sha: str) -> bool:
    try:
      if path.stat().st_size != expected_size:
        return False
      digest = hashlib.sha256()
      with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
          digest.update(chunk)
      return digest.hexdigest() == expected_sha
    except OSError:
      return False

  async def _materialize_downloadable_outputs(
    self, session_id: str, result: dict,
  ) -> dict:
    """Stream omitted large outputs from the authenticated sub-agent API."""
    manifest = result.get("output_files_content")
    if not isinstance(manifest, list) or not manifest:
      return result
    base_url = SUBAGENT_URL.rstrip("/") + "/"
    base_origin = self._origin(base_url)
    updated_entries: list = []
    materialized_any = False
    download_spool_dir: str | None = None
    # Output downloads are main -> sub-agent API calls.  Keep that credential
    # separate from the reverse-direction callback secret so compromising one
    # channel does not automatically authenticate the other.
    token = subagent_api_token_env()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    timeout = aiohttp.ClientTimeout(total=SUBAGENT_OUTPUT_DOWNLOAD_TIMEOUT_S)

    async with aiohttp.ClientSession(timeout=timeout) as session:
      for index, raw_item in enumerate(manifest):
        if not isinstance(raw_item, dict):
          updated_entries.append(raw_item)
          continue
        item = dict(raw_item)
        if item.get("content_base64") or item.get("local_path"):
          updated_entries.append(item)
          continue
        download_url = item.get("download_url")
        if not isinstance(download_url, str) or not download_url.strip():
          updated_entries.append(item)
          continue
        resolved_url = urljoin(base_url, download_url.strip())
        if self._origin(resolved_url) != base_origin:
          raise _OutputDownloadError("download_url origin does not match SUBAGENT_URL")
        try:
          expected_size = int(item.get("size_bytes"))
        except (TypeError, ValueError):
          raise _OutputDownloadError("download manifest has invalid size_bytes") from None
        expected_sha = str(item.get("sha256") or "").strip().lower()
        if expected_size < 0 or expected_size > MAX_FILE_SIZE_BYTES:
          raise _OutputDownloadError(
            f"downloaded output size {expected_size} exceeds the 200 MB limit"
          )
        if len(expected_sha) != 64 or any(ch not in "0123456789abcdef" for ch in expected_sha):
          raise _OutputDownloadError("download manifest has invalid sha256")
        # Native/same-host deployments may expose the receiver's output path
        # directly.  Prefer that verified file over a network round-trip, but
        # never trust the path alone: size and digest must match the callback
        # descriptor before the tracker records it.
        shared_path = item.get("path")
        if isinstance(shared_path, (str, os.PathLike)) and str(shared_path):
          shared_file = Path(shared_path)
          if await asyncio.to_thread(
            self._existing_download_matches,
            shared_file,
            expected_size,
            expected_sha,
          ):
            item["local_path"] = str(shared_file.resolve())
            updated_entries.append(item)
            materialized_any = True
            continue
        file_id = str(item.get("file_id") or f"output-{index}")
        name = str(item.get("name") or f"output-{index}")
        destination = self._tracker.callback_download_path(session_id, file_id, name)
        if destination is None:
          raise _OutputDownloadError("durable callback spool is not ready")
        if await asyncio.to_thread(
          self._existing_download_matches, destination, expected_size, expected_sha,
        ):
          item["local_path"] = str(destination.resolve())
          updated_entries.append(item)
          materialized_any = True
          download_spool_dir = str(destination.parent.resolve())
          continue
        temporary = destination.with_suffix(destination.suffix + ".download")
        digest = hashlib.sha256()
        received = 0
        try:
          async with session.get(
            resolved_url, headers=headers, allow_redirects=False,
          ) as response:
            if response.status != 200:
              raise _OutputDownloadError(
                f"output download returned HTTP {response.status}"
              )
            response_sha = response.headers.get("X-Content-SHA256")
            if response_sha and response_sha.strip().lower() != expected_sha:
              raise _OutputDownloadError("output response sha256 header mismatch")
            with temporary.open("wb") as handle:
              async for chunk in response.content.iter_chunked(1024 * 1024):
                received += len(chunk)
                if received > expected_size or received > MAX_FILE_SIZE_BYTES:
                  raise _OutputDownloadError("output download exceeded declared size")
                digest.update(chunk)
                handle.write(chunk)
          if received != expected_size:
            raise _OutputDownloadError(
              f"output download size mismatch ({received} != {expected_size})"
            )
          if digest.hexdigest() != expected_sha:
            raise _OutputDownloadError("output download sha256 mismatch")
          os.replace(temporary, destination)
        except Exception:
          try:
            temporary.unlink(missing_ok=True)
          except OSError:
            pass
          raise
        item["local_path"] = str(destination.resolve())
        updated_entries.append(item)
        materialized_any = True
        download_spool_dir = str(destination.parent.resolve())

    if not materialized_any:
      return result
    hydrated = dict(result)
    hydrated["output_files_content"] = updated_entries
    # Tracker cleanup validates this path is under its own callback inbox.
    if download_spool_dir:
      hydrated["_spooled_output_dir"] = download_spool_dir
    return hydrated

  async def _handle_callback(self, request: web.Request) -> web.Response:
    if not self._is_authorized(request):
      logger.warning("SubAgent callback: rejected invalid authentication token")
      return web.json_response({"status": "unauthorized"}, status=401)
    try:
      data = await request.json()
    except web.HTTPRequestEntityTooLarge:
      logger.warning(
        "SubAgent callback: request body too large (max %d bytes); "
        "lower SUBAGENT_MAX_INLINE_FILE_BYTES on the SubAgents side "
        "or raise SUBAGENT_WEBHOOK_MAX_BODY_BYTES on this side",
        self._client_max_size,
      )
      return web.Response(status=413, text="Request body too large")
    except Exception:
      logger.warning("SubAgent callback: invalid JSON received")
      return web.Response(status=400, text="Invalid JSON")

    if not isinstance(data, dict):
      return web.Response(status=400, text="JSON body must be an object")
    msg_type = data.get("type")
    session_id = data.get("session_id")
    if not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 512:
      logger.warning("SubAgent callback: missing session_id")
      return web.Response(status=400, text="Invalid session_id")
    session_id = session_id.strip()

    if msg_type == "progress":
      entry = data.get("entry") or {}
      if not isinstance(entry, dict):
        return web.Response(status=400, text="Invalid progress entry")
      step = str(entry.get("step", "unknown"))
      detail = str(entry.get("detail", ""))
      # ``reason`` is the new native-tool-call payload field; older sub-
      # agents that still emit only ``detail`` will leave it as None.
      reason_value = entry.get("reason")
      reason = str(reason_value) if reason_value is not None else None
      self._tracker.update_progress(session_id, step, detail, reason=reason)
      # Signal the keepalive event so the bridge resets its timeout.
      progress_event = self._progress_events.get(session_id)
      if progress_event is not None and not progress_event.is_set():
        progress_event.set()
      # Promoted from DEBUG → INFO so progress is visible at default
      # log level. The bridge previously logged at DEBUG, so operators
      # had no signal that the sub-agent was actually running unless
      # they cranked LOG_LEVEL globally.
      logger.info(
        "SubAgent progress: session=%s step=%s reason=%s detail=%s",
        session_id,
        step,
        (reason[:160] if isinstance(reason, str) else reason),
        (detail[:160] if isinstance(detail, str) else detail),
      )
      return web.json_response({"status": "ok"})

    if msg_type == "complete":
      result = data.get("result") or {}
      if not isinstance(result, dict):
        return web.Response(status=400, text="Invalid result")
      if self._tracker.is_delivered(session_id):
        return web.json_response({"status": "ok", "duplicate": True})
      if (
        session_id in self._waiter_owned_sessions
        and session_id not in self._completion_events
        and self._tracker.is_finished(session_id)
      ):
        return web.json_response({"status": "ok", "duplicate": True})
      try:
        result = await self._materialize_downloadable_outputs(session_id, result)
      except _OutputDownloadError as exc:
        logger.warning(
          "SubAgent output download failed session=%s: %s", session_id, exc,
        )
        return web.json_response(
          {"status": "output_download_failed", "retryable": True}, status=502,
        )
      accepted = self._tracker.finalize(session_id, result)
      if not accepted:
        # Retain the payload durably for a registration race/restart replay,
        # but do not return 2xx: that would tell the sender it is safe to delete
        # its only copy even though no task currently owns the result.
        self._tracker.defer_completion(session_id, result)
        logger.warning(
          "SubAgent complete deferred: unknown session=%s; sender should retry",
          session_id,
        )
        return web.json_response(
          {"status": "pending_registration", "retryable": True}, status=409,
        )
      event = self._completion_events.pop(session_id, None)
      if event is not None:
        event.set()
        # If the first HTTP response is lost, a quick callback retry must stay
        # owned by the live coordinator instead of taking the restart-recovery
        # path and delivering a duplicate.
        asyncio.get_running_loop().call_later(
          300.0, self._waiter_owned_sessions.discard, session_id,
        )
      elif session_id in self._waiter_owned_sessions or self._tracker.is_delivered(session_id):
        logger.info("SubAgent complete duplicate: session=%s", session_id)
      else:
        finished = self._tracker.get_finished(session_id)
        handler = self._completion_recovery_handler
        if finished is None:
          return web.json_response(
            {"status": "pending_registration", "retryable": True}, status=409,
          )
        if handler is None:
          logger.warning("SubAgent recovery delivery not ready: session=%s", session_id)
          return web.json_response(
            {"status": "recovery_not_ready", "retryable": True}, status=503,
          )
        try:
          await handler(finished.chat_id, session_id)
        except Exception as exc:  # pylint: disable=broad-except
          logger.exception(
            "SubAgent recovery delivery failed session=%s: %s", session_id, exc,
          )
          return web.json_response(
            {"status": "recovery_failed", "retryable": True}, status=500,
          )
        self._tracker.mark_delivered(session_id)
      # Also clean up the keepalive event — no more progress will arrive.
      self._progress_events.pop(session_id, None)
      # Drop dedup state — once the session is finalised, any future
      # webhook with the same session_id is a real new event (extremely
      # unlikely in practice, but cheap to be tidy).
      self._queue_last_emit.pop(session_id, None)
      logger.info(
        "SubAgent complete: session=%s success=%s",
        session_id,
        result.get("success"),
      )
      return web.json_response({"status": "ok"})

    if msg_type == "steering":
      # Steering acknowledgements are purely informational — the bridge
      # already confirmed delivery via the /steer HTTP response. No action
      # needed on this side.
      return web.json_response({"status": "ok"})

    if msg_type in ("queued", "queue_advanced", "queue_status"):
      # The sub-agent is letting us know this session's position in the
      # global FIFO queue. We forward the position to the WhatsApp chat
      # via ``self._queue_handler`` (registered by main.py with a closure
      # over the live ws connection). The handler decides on the exact
      # WA wording — this layer just dedups and routes.
      try:
        position = int(data.get("position", 0) or 0)
        queue_size = int(data.get("queue_size", 0) or 0)
      except (TypeError, ValueError):
        logger.warning(
          "SubAgent queue webhook: bad position/queue_size session=%s data=%s",
          session_id,
          data,
        )
        return web.Response(status=400, text="Bad position/queue_size")

      # Waiting in the global FIFO is legitimate activity. Treat every valid
      # queue callback (including a deduped notification or one received while
      # the WhatsApp gateway handler is reconnecting) as a timeout keepalive.
      progress_event = self._progress_events.get(session_id)
      if progress_event is not None and not progress_event.is_set():
        progress_event.set()

      if self._is_duplicate_queue_event(session_id, position, queue_size):
        logger.debug(
          "SubAgent queue webhook deduped: session=%s type=%s position=%s",
          session_id,
          msg_type,
          position,
        )
        return web.json_response({"status": "deduped"})

      chat_id = self._tracker.get_chat_for_session(session_id)
      if not chat_id:
        # Session not (or no longer) tracked. Logging at INFO not WARN
        # because this is genuinely possible: the queue webhook can
        # race the bridge's own ``finalize`` call on a fast-path error.
        logger.info(
          "SubAgent queue webhook: no active task for session=%s type=%s",
          session_id,
          msg_type,
        )
        return web.json_response({"status": "no_active_task"})

      handler = self._queue_handler
      if handler is None:
        logger.info(
          "SubAgent queue webhook: no handler registered (gateway disconnected?) session=%s",
          session_id,
        )
        return web.json_response({"status": "no_handler"})

      try:
        await handler(chat_id, msg_type, position, queue_size)
      except Exception as exc:  # pylint: disable=broad-except
        logger.warning(
          "SubAgent queue handler failed session=%s type=%s: %s",
          session_id,
          msg_type,
          exc,
        )
        # Don't record dedup state — the sub-agent should be free to
        # retry this exact (position, queue_size) and have us deliver it.
        return web.json_response({"status": "handler_error"}, status=500)

      # Only commit dedup state after the handler accepted the event.
      # Anything earlier risks silently dropping a retry of a failed
      # delivery within the dedup window.
      self._record_queue_emit(session_id, position, queue_size)

      logger.info(
        "SubAgent queue webhook delivered session=%s chat=%s type=%s position=%s queue_size=%s",
        session_id,
        chat_id,
        msg_type,
        position,
        queue_size,
      )
      return web.json_response({"status": "ok"})

    logger.warning("SubAgent callback: unknown type=%s", msg_type)
    return web.Response(status=400, text="Unknown type")

  async def _handle_health(self, request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})
