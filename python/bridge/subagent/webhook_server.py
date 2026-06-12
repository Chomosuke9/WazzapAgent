from __future__ import annotations

import asyncio
import time
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
from .config import SUBAGENT_WEBHOOK_PORT, subagent_webhook_max_body_bytes_raw
from .tracker import SubTaskTracker

logger = setup_logging()


QueueEventHandler = Callable[[str, str, int, int], Awaitable[None]]
# Signature: handler(chat_id, event_type, position, queue_size) -> awaitable


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
    self._port = port or SUBAGENT_WEBHOOK_PORT
    self._completion_events: Dict[str, asyncio.Event] = {}
    # Keepalive events: set each time a progress webhook arrives so the
    # bridge can reset its per-batch timeout instead of treating a slow
    # but still-working sub-agent as dead.
    self._progress_events: Dict[str, asyncio.Event] = {}
    self._runner: web.AppRunner | None = None
    self._site: web.TCPSite | None = None
    self._queue_handler: Optional[QueueEventHandler] = None
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
    app = web.Application(client_max_size=self._client_max_size)
    app.router.add_post("/subagent/callback", self._handle_callback)
    app.router.add_get("/health", self._handle_health)
    self._runner = web.AppRunner(app)
    await self._runner.setup()
    self._site = web.TCPSite(self._runner, "0.0.0.0", self._port)
    await self._site.start()
    logger.info("SubAgent webhook server started on port %s", self._port)

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
    self._shutdown = False

    async def _keeper() -> None:
      """Background loop: start the server, restart on crash."""
      attempt = 0
      while not self._shutdown:
        try:
          await self.start()
          # ``start()`` only returns after ``site.start()`` succeeds.
          # The site keeps running until it is explicitly stopped or
          # the runner is cleaned up. We periodically probe the
          # /health endpoint so we can detect a silently-dead server
          # (e.g. port became unavailable after startup).
          while not self._shutdown:
            await asyncio.sleep(self._HEALTH_CHECK_INTERVAL_S)
            if self._shutdown:
              break
            # Probe /health to confirm the server is still alive.
            # A live check is more reliable than checking object
            # references which may remain non-None even after the
            # server has stopped accepting connections.
            if not await self._check_health():
              logger.warning(
                "SubAgent webhook server health check failed; restarting"
              )
              await self._do_stop()
              break  # restart outer loop
          # If we exited the inner loop due to _shutdown, stop cleanly.
          if self._shutdown:
            await self._do_stop()
            return
        except Exception as exc:  # pylint: disable=broad-except
          attempt += 1
          logger.error(
            "SubAgent webhook server crashed (attempt %d); restarting in %ds: %s",
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
    url = f"http://127.0.0.1:{self._port}/health"
    try:
      async with aiohttp.ClientSession() as session:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=3)) as resp:
          return resp.status == 200
    except Exception:
      return False

  async def _do_stop(self) -> None:
    """Internal cleanup: stop the site and runner if they exist."""
    if self._site is not None:
      await self._site.stop()
      self._site = None
    if self._runner is not None:
      await self._runner.cleanup()
      self._runner = None

  def register_completion_event(self, session_id: str, event: asyncio.Event) -> None:
    self._completion_events[session_id] = event

  def unregister_completion_event(self, session_id: str) -> None:
    """Remove completion event to prevent memory leak."""
    self._completion_events.pop(session_id, None)

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

  async def _handle_callback(self, request: web.Request) -> web.Response:
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

    msg_type = data.get("type")
    session_id = data.get("session_id")
    if not session_id:
      logger.warning("SubAgent callback: missing session_id")
      return web.Response(status=400, text="Missing session_id")

    if msg_type == "progress":
      entry = data.get("entry") or {}
      step = entry.get("step", "unknown")
      detail = entry.get("detail", "")
      # ``reason`` is the new native-tool-call payload field; older sub-
      # agents that still emit only ``detail`` will leave it as None.
      reason = entry.get("reason")
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
      self._tracker.finalize(session_id, result)
      event = self._completion_events.pop(session_id, None)
      if event is not None:
        event.set()
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
