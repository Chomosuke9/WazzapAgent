"""Step 32 — per-account ``AgentSession`` (Python state isolation).

All per-account agent state that used to live as locals inside
``bridge.main.handle_socket`` (``per_chat`` history, ``per_chat_lock``,
``pending_by_chat``, ``media_paths_by_chat``, the sub-agent tracker / client /
webhook, reply-dedup signatures, idle counters, and the ``pending_*_chat``
ack-tracking maps) is encapsulated here as INSTANCE attributes of
:class:`AgentSession`. Each ``WaSocket`` (i.e. each WhatsApp account) gets its
own ``AgentSession``, so running N accounts in one process (Step 33) keeps their
agent state fully isolated.

The handler closures that used to be defined inside ``handle_socket``
(``process_message_batch``, ``flush_pending``, ``_deliver_subagent_result``, the
``@sock.on(...)`` event handlers, and the small helpers ``_track_task`` /
``_on_subagent_queue_event`` / ``_is_duplicate_reply`` / ``_should_idle_trigger``)
are re-homed VERBATIM as self-bound closures created in :meth:`AgentSession.register`.
``register`` binds ``self``'s state attributes to locals of the same name so the
moved bodies are byte-for-byte identical to Steps 28/29; they mutate the shared
mutable containers in place, so every mutation lands on ``self``'s attributes.

Sub-agent isolation: the tracker, client, and webhook server are PER-SESSION
instance attributes (``self.subagent_tracker`` / ``self.subagent_client`` /
``self.subagent_webhook``) instead of module-level singletons. This is the
isolation-preserving choice mandated by the step: each account's sub-agent
state is private. The webhook server binds a port at ``start_persistent`` time;
Step 33 (multi-account boot) is responsible for resolving the single-port
constraint (e.g. one shared webhook server routing callbacks by session_id) —
that is explicitly out of scope here, where ``main()`` constructs exactly one
session.

Scope: this module ONLY relocates state + handler wiring. The agent's
batching / LLM / sub-agent logic is unchanged. The one deliberate deviation
from a byte-for-byte copy is that ``create_sticker_file`` (which imports PIL) is
imported lazily inside the ``/sticker`` command branch instead of at module
top-level, so this module — and therefore ``test_agent_session`` — can be
imported in environments without PIL (mirroring how the existing
``test_idle_trigger`` / ``test_hydration`` suites avoid the heavy
``bridge.main`` import).
"""
from __future__ import annotations

import asyncio
import contextlib
from collections import OrderedDict, defaultdict, deque
from pathlib import Path
from typing import Deque, Dict, Set

from .history import (
  WhatsAppMessage,
  set_tenant_assistant_name,
  reset_tenant_assistant_name,
  tenant_assistant_name_context,
)
from .log import setup_logging
from .llm.llm1 import call_llm1
from .llm.llm2 import generate_reply
from .db import (
  is_muted as db_is_muted,
  set_llm2_model as db_set_llm2_model,
  clear_llm2_model_cache as db_clear_llm2_model_cache,
  reset_settings_connection as db_reset_settings_connection,
  invalidate_chat_caches as db_invalidate_chat_caches,
  close_all_connections as db_close_all_connections,
  checkpoint_all_dbs as db_checkpoint_all_dbs,
  clear_subagent_enabled_cache as db_clear_subagent_enabled_cache,
  get_idle_trigger as db_get_idle_trigger,
  get_prompt as db_get_prompt,
  ScheduledTasksRepository,
  set_tenant_db_dir as db_set_tenant_db_dir,
  reset_tenant_db_dir as db_reset_tenant_db_dir,
  tenant_db_context as db_tenant_db_context,
)
from .dashboard import DashboardStats
from .messaging.processing import (
  _make_request_id,
  _reply_signature,
)
from .messaging.actions import (
  _extract_actions,
  _extract_actions_from_tool_calls,
)
from .messaging.gateway import (
  send_delete_message,
)

from .agent.idle_trigger import IdleTrigger
from .agent.reply_dedup import ReplyDedup
from .agent.mute_gate import MuteGate
from .agent.llm1_router import Llm1Router
from .agent.llm2_responder import Llm2Responder

from .subagent import (
  SubTaskTracker,
  SubAgentClient,
  SubAgentWebhookServer,
)

from .config import (
  REPLY_DEDUP_WINDOW_MS,
  REPLY_DEDUP_MIN_CHARS,
  direct_invoke_api_key,
  direct_invoke_host,
  direct_invoke_max_chars,
  direct_invoke_port as _direct_invoke_base_port,
)

logger = setup_logging()

from .agent.batch_processor import BatchProcessor, PendingChat
from .agent.event_router import EventRouter
from .agent.ack_hydrator import AckHydrator
from .agent.subagent_coordinator import SubAgentCoordinator
from .agent.scheduled_task_runner import ScheduledTaskRunner
from .agent.chat_reinvoker import ChatReinvoker
from .agent.direct_invoke import DirectInvokeServer


# Direct-invoke re-invoke instruction block (counterpart of the scheduled-task
# block in scheduled_task_runner.py). Frames the injected ``#system`` turn as an
# external trigger the bot must act on NOW by sending a message in the chat.
_DIRECT_INVOKE_BLOCK_TITLE = "Direct instruction firing now"
_DIRECT_INVOKE_BLOCK_INSTRUCTIONS = (
  "Instructions for this re-invoke:\n"
  "- An external trigger just sent the bot the instruction above to act on in "
  "this chat NOW.\n"
  "- Carry it out and respond in this chat: send the appropriate reply_message "
  "(and/or tools) in the chat's language and WhatsApp formatting.\n"
  "- If the instruction names someone to tag, use the `@Name (senderRef)` "
  "mention format so they get tagged.\n"
  "- Do not ask for confirmation — just perform the instruction."
)


class AgentSession:
  """Encapsulates all per-account agent state + handler wiring for one
  :class:`~wasocket.socket.WaSocket` (one WhatsApp account).

  ``__init__`` allocates every per-account container as an INSTANCE attribute;
  :meth:`register` wires the ``@sock.on(...)`` event handlers (the Step 28/29
  bodies, now self-bound); :meth:`run` drives the connect → wait → cleanup
  lifecycle (the former ``handle_socket`` tail).
  """

  def __init__(self, sock, *, webhook_port: int | None = None, webhook_url: str | None = None, assistant_name: str | None = None, direct_invoke_port: int | None = None) -> None:
    self.sock = sock
    # Tenant key for per-account DB routing (Step 33 / CONTRACT.md §8). The
    # WaSocket carries its ``folder_path``; ``run()`` binds it so every DB
    # access made by this session's handlers resolves under ``<folder_path>/db``
    # with no cross-talk with other accounts sharing the event loop.
    self.folder_path = getattr(sock, "folder_path", None)
    # Per-tenant assistant identity (CONTRACT.md §8). ``run()`` / ``tenant_db()``
    # bind this into the ``bridge.history`` ContextVar so name resolution
    # (``assistant_name`` / aliases / mention pattern) uses THIS account's
    # identity. ``None`` selects the legacy ``ASSISTANT_NAME`` env (single-account
    # behaviour unchanged).
    self.assistant_name_config = assistant_name
    # --- per-account agent state (was: handle_socket locals) ---
    self.per_chat: Dict[str, Deque[WhatsAppMessage]] = defaultdict(deque)
    self.per_chat_lock: Dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)
    self.pending_by_chat: Dict[str, PendingChat] = defaultdict(PendingChat)
    self.pending_send_request_chat: OrderedDict[str, str] = OrderedDict()
    # ``recent_reply_signatures_by_chat`` is bound below to the ReplyDedup
    # collaborator's own ``signatures_by_chat`` (single shared state, Step 08).
    self.media_paths_by_chat: Dict[str, Dict[str, list]] = defaultdict(dict)
    # Staged sub-agent output files awaiting an action_ack. Keyed by
    # ``request_id`` -> ``(chat_id, file_info_list)``; LRU-capped (see ack hydrator).
    self.pending_subagent_attachments: OrderedDict[str, tuple[str, list[dict]]] = OrderedDict()
    # `run_command` actions awaiting an action_ack: ``request_id`` -> ``(chat_id, command_text)``.
    self.pending_run_command_chat: OrderedDict[str, tuple[str, str]] = OrderedDict()
    self.idle_msg_count: Dict[str, int] = defaultdict(int)
    self.tasks: Set[asyncio.Task] = set()
    # --- per-session dashboard stats (was: module-level singletons) ---
    # Own stat buffers + flush loop, written only to this tenant's stats DB.
    self._dashboard = DashboardStats()
    # --- per-session sub-agent objects (was: module-level singletons) ---
    # Fully isolated per account (Step 33 owns the single-port webhook constraint).
    tracker_state_path = None
    if self.folder_path:
      tenant_root = Path(self.folder_path).expanduser().resolve()
      # Node normally creates the tenant layout before the bridge starts.  The
      # existence guard keeps dependency-light unit fakes such as
      # ``/tenant-a`` from creating directories outside their test workspace.
      if tenant_root.exists():
        tracker_state_path = tenant_root / "db" / "subagent_tracker.json"
    self.subagent_tracker = SubTaskTracker(state_path=tracker_state_path)
    self.subagent_client = SubAgentClient(webhook_url=webhook_url)
    self.subagent_webhook = SubAgentWebhookServer(self.subagent_tracker, port=webhook_port)
    # Stashed in register() so run() can (re)wire / tear down the webhook
    # queue handler around the gateway connection.
    self._queue_handler = None

    # --- Step 08: extracted per-account collaborators (DI seams) ---
    self._idle = IdleTrigger(get_idle_trigger=db_get_idle_trigger)
    self._dedup = ReplyDedup(
      window_ms=REPLY_DEDUP_WINDOW_MS,
      min_chars=REPLY_DEDUP_MIN_CHARS,
      reply_signature=_reply_signature,
    )
    # Legacy attribute name points at the dedup's own state (single shared deque).
    self.recent_reply_signatures_by_chat = self._dedup.signatures_by_chat
    self._mute = MuteGate(
      is_muted=db_is_muted,
      send_delete_message=send_delete_message,
      make_request_id=_make_request_id,
    )

    # --- Step 09: LLM pipeline collaborators (DI seams) ---
    self._llm1 = Llm1Router(call_llm1=call_llm1)
    self._llm2 = Llm2Responder(
      generate_reply=generate_reply,
      extract_actions_from_tool_calls=_extract_actions_from_tool_calls,
      extract_actions=_extract_actions,
    )

    # --- Step 10: orchestration collaborators (composition root) ---
    # Each owns one slice of the former ``_register_handlers`` closures and is
    # constructed with explicit per-account deps so it is unit-testable and
    # fully INSTANCE-scoped (no module-level mutable per-account state).
    self._events = EventRouter(
      per_chat=self.per_chat,
      idle_msg_count=self.idle_msg_count,
      subagent_tracker=self.subagent_tracker,
      reset_settings_connection=db_reset_settings_connection,
      invalidate_chat_caches=db_invalidate_chat_caches,
      clear_llm2_model_cache=db_clear_llm2_model_cache,
      set_llm2_model=db_set_llm2_model,
      clear_subagent_enabled_cache=db_clear_subagent_enabled_cache,
    )
    self._ack = AckHydrator(
      per_chat=self.per_chat,
      per_chat_lock=self.per_chat_lock,
      pending_send_request_chat=self.pending_send_request_chat,
      pending_subagent_attachments=self.pending_subagent_attachments,
      pending_run_command_chat=self.pending_run_command_chat,
      media_paths_by_chat=self.media_paths_by_chat,
    )
    self._subagent = SubAgentCoordinator(self)
    self._batch = BatchProcessor(self)
    # --- Shared cold re-invoke engine (scheduled tasks + direct invoke) ---
    # ONE instance reused by the scheduled-task runner and the direct-invoke
    # HTTP endpoint: append a [LABEL] #system turn to the chat history, re-invoke
    # LLM2 (always responds — no LLM1 gating), and dispatch the reply.
    self._reinvoker = ChatReinvoker(
      ws=self.sock,
      responder=self._llm2,
      per_chat=self.per_chat,
      per_chat_lock=self.per_chat_lock,
      get_prompt=db_get_prompt,
      record_stat=self._dashboard.record_stat,
      pending_send_request_chat=self.pending_send_request_chat,
    )
    # --- Feature 5: scheduled-task runner (one-shot timers + re-invoke) ---
    # Persists `/schedule-task` rows in this tenant's settings.db and re-invokes
    # LLM2 in the target chat when each fires. Dependencies are injected so the
    # runner stays INSTANCE-scoped and unit-testable; it shares the reinvoker above.
    self._scheduled = ScheduledTaskRunner(
      repository=ScheduledTasksRepository(),
      ws=self.sock,
      responder=self._llm2,
      per_chat=self.per_chat,
      per_chat_lock=self.per_chat_lock,
      track_task=self._track_task,
      get_prompt=db_get_prompt,
      record_stat=self._dashboard.record_stat,
      reinvoker=self._reinvoker,
    )
    # --- Direct-invoke HTTP endpoint (make the bot send a message FIRST) ---
    # Authenticated /post endpoint; binds (in run()) ONLY when DIRECT_INVOKE_API_KEY
    # is set (fail-closed). Per-account port = base + index (resolved by main.py);
    # falls back to the configured base for single-account / tests.
    self._direct_invoke = DirectInvokeServer(
      submit=self._submit_direct_invoke,
      api_key=direct_invoke_api_key(),
      host=direct_invoke_host(),
      port=direct_invoke_port if direct_invoke_port is not None else _direct_invoke_base_port(),
      max_chars=direct_invoke_max_chars(),
    )
    # The webhook server's queue handler (was wired inside _register_handlers).
    self._queue_handler = self._subagent.queue_event

  def _track_task(self, task: asyncio.Task) -> None:
    self.tasks.add(task)
    task.add_done_callback(self.tasks.discard)

  def _submit_direct_invoke(self, chat_id: str, prompt: str) -> None:
    """Schedule a direct-invoke re-invoke as a tracked background task.

    Called by :class:`~bridge.agent.direct_invoke.DirectInvokeServer` from its
    (already-authenticated) HTTP handler. The actual LLM2 work runs in the
    background so a slow model never blocks the HTTP response. It is wrapped in
    ``tenant_db()`` so it runs under THIS session's per-tenant DB dir + assistant
    identity — the aiohttp request task does not otherwise inherit ``run()``'s
    ContextVars, so without this a multi-account deploy could touch the wrong
    tenant's DB.
    """
    async def _run() -> None:
      with self.tenant_db():
        try:
          await self._reinvoker.reinvoke(
            chat_id,
            prompt,
            system_label="DIRECT INVOKE",
            block_title=_DIRECT_INVOKE_BLOCK_TITLE,
            block_instructions=_DIRECT_INVOKE_BLOCK_INSTRUCTIONS,
            log_kind="direct invoke",
          )
        except Exception:  # pylint: disable=broad-except
          logger.exception("direct invoke failed chat_id=%s", chat_id)

    self._track_task(asyncio.create_task(_run()))

  def register(self) -> None:
    """Wire the WaSocket event handlers for this session (Step 10).

    Delegates to the module-level :func:`_register_handlers`, which binds each
    ``@ws.on(...)`` handler to the per-account collaborator that owns that
    concern (:class:`BatchProcessor` / :class:`EventRouter` / :class:`AckHydrator`).
    No business logic lives in the handler closures anymore.
    """
    _register_handlers(self)

  async def run(self, node_url, stop_event) -> None:
    """Connect to the Node gateway and pump events until ``stop_event``.

    Tail of the former ``handle_socket``: start the dashboard flush loop, wire
    the sub-agent queue handler, connect, wait for the shutdown signal, then
    flush/close and cancel background tasks. ``register`` must run first.
    """
    ws = self.sock
    logger.info("Gateway connected")

    # Bind this session's per-tenant DB directory for the whole run (Step 33 /
    # CONTRACT.md §8). Setting the ContextVar HERE — before ``connect()`` spawns
    # the transport pump task — means the pump task (and every event handler it
    # invokes) inherits this context, so all DB access this session makes
    # resolves under ``<folder_path>/db`` with no cross-talk with other
    # accounts sharing the event loop. ``folder_path is None`` keeps the legacy
    # global paths (single-account / tests).
    db_token = db_set_tenant_db_dir(self.folder_path)
    # Bind this session's assistant identity for the whole run (mirrors the DB
    # dir binding above), so every name resolution this session's handlers make
    # uses THIS account's identity. ``None`` keeps the legacy env identity.
    name_token = set_tenant_assistant_name(self.assistant_name_config)

    # Start dashboard flush loop
    dashboard_task = await self._dashboard.start_flush_loop()
    self.tasks.add(dashboard_task)

    self.subagent_webhook.set_queue_handler(self._queue_handler)
    # Capture one bound-method object: identity-checked teardown must receive
    # the same object, not a fresh ``self._subagent.recover_completion`` wrapper.
    recovery_handler = self._subagent.recover_completion

    try:
      await ws.connect(node_url)
      logger.info("Connected to Node gateway at %s", node_url)
      if self.folder_path:
        # The tenant root may be mounted/created by Node only during connect.
        # Attach durable sub-agent state now even if it was unavailable when
        # AgentSession was constructed.
        self.subagent_tracker.enable_persistence(
          Path(self.folder_path).expanduser().resolve()
          / "db"
          / "subagent_tracker.json"
        )
      self.subagent_webhook.set_completion_recovery_handler(recovery_handler)
      # Persistence can contain results accepted just before an earlier bridge
      # process died.  Replay them only after the gateway handshake and recovery
      # handler are live, so confirmed WhatsApp sends can tombstone each exact
      # session without waiting for the receiver to emit another callback.
      await self._subagent.recover_pending_completions()

      # Only activate cold outbound work after the hello/hello_ack handshake.
      # Otherwise an overdue task (or an early direct-invoke request) can reach
      # WaSocket while its best-effort transport is disconnected, be silently
      # dropped, and still be treated as completed.
      #
      # Re-arming runs under the tenant DB context bound above so it reads THIS
      # account's settings.db; armed timers inherit the context for their own
      # DB access.
      self._scheduled.rearm_pending()

      # Direct-invoke HTTP endpoint: bind only once outbound delivery is ready
      # (no-op unless DIRECT_INVOKE_API_KEY is set). Its background re-invokes
      # bind the tenant context themselves (see _submit_direct_invoke).
      await self._direct_invoke.start()

      await stop_event.wait()
    finally:
      # Stop accepting new direct-invoke requests before tearing down state.
      try:
        await self._direct_invoke.stop()
      except Exception as exc:  # pragma: no cover - defensive
        logger.debug("Direct-invoke endpoint stop failed: %s", exc)
      # Flush dashboard stats and checkpoint DBs before shutting down
      self._dashboard.flush_to_db()
      db_checkpoint_all_dbs()
      db_close_all_connections()
      # Detach the queue handler so the webhook server doesn't write to a
      # closed socket between gateway connections.
      self.subagent_webhook.clear_queue_handler_if(self._queue_handler)
      self.subagent_webhook.clear_completion_recovery_handler_if(recovery_handler)
      try:
        await ws.disconnect()
      except Exception as exc:  # pragma: no cover - defensive
        logger.debug("WaSocket disconnect failed: %s", exc)
      for task in self.tasks:
        task.cancel()
      if self.tasks:
        await asyncio.gather(*self.tasks, return_exceptions=True)
      db_reset_tenant_db_dir(db_token)
      reset_tenant_assistant_name(name_token)

  def tenant_db(self):
    """Context manager binding this session's per-tenant DB directory AND its
    assistant identity.

    Mirrors what :meth:`run` does for the live event loop, exposed so callers
    (and tests) can perform DB / identity operations "as this session" — i.e.
    routed to ``<folder_path>/db`` with this account's assistant name — outside
    the running pump.
    """
    return self._tenant_scope()

  @contextlib.contextmanager
  def _tenant_scope(self):
    with db_tenant_db_context(self.folder_path):
      with tenant_assistant_name_context(self.assistant_name_config):
        yield


def _register_handlers(session) -> None:
  """Wire the WaSocket event handlers to this session's collaborators (Step 10).

  Thin composition root: every ``@ws.on(...)`` handler simply delegates to the
  per-account collaborator that owns that concern
  (:class:`BatchProcessor` / :class:`EventRouter` / :class:`AckHydrator`).
  No business logic lives in these closures anymore.
  """
  ws = session.sock
  batch = session._batch
  events = session._events
  ack = session._ack

  @ws.on("ready")
  async def _on_ready(_payload):
    logger.info("Gateway connected (ready)")

  @ws.on("status")
  async def _on_status(status):
    # The old loop ignored whatsapp_status; preserve that no-op. Status values
    # are normalized to open|connecting|close.
    logger.debug("whatsapp_status: %s", status)

  @ws.on("error")
  async def _on_error(err):
    logger.warning("Gateway error: %s", err)

  @ws.on("action_ack")
  async def _on_action_ack(ack_evt):
    await ack.handle(ack_evt)

  @ws.on("send_ack")
  async def _on_send_ack(ack_evt):
    # Legacy companion of a successful send_message; authoritative hydration
    # runs on action_ack. Preserve the old loop's debug-only behavior.
    logger.debug("Gateway send_ack: %s", getattr(ack_evt, "request_id", None))

  @ws.on("clear_history")
  async def _on_clear_history(evt):
    await events.handle(evt)

  @ws.on("invalidate_llm2_model")
  async def _on_invalidate_llm2_model(evt):
    await events.handle(evt)

  @ws.on("set_llm2_model")
  async def _on_set_llm2_model(evt):
    await events.handle(evt)

  @ws.on("invalidate_default_model")
  async def _on_invalidate_default_model(evt):
    await events.handle(evt)

  @ws.on("set_subagent_enabled")
  async def _on_set_subagent_enabled(evt):
    await events.handle(evt)

  @ws.on("invalidate_chat_settings")
  async def _on_invalidate_chat_settings(evt):
    await events.handle(evt)

  @ws.on("schedule_task")
  async def _on_schedule_task(evt):
    # Feature 5: persist + arm a one-shot scheduled task (re-invokes LLM2 on fire).
    await session._scheduled.schedule(evt)

  @ws.on("message")
  async def _on_message(msg):
    # `msg` is a wasocket.WhatsAppMessage; `.raw` is the original
    # incoming_message payload dict, so the existing pipeline runs verbatim.
    await batch.dispatch_incoming(msg.raw)
