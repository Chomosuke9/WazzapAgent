"""``EventRouter`` — control-event handling (Step 10).

Lifts the control-event branches out of the former ``_dispatch_event`` closure
in ``session.py`` (the ``clear_history`` / ``set_llm2_model`` /
``invalidate_llm2_model`` / ``invalidate_default_model`` /
``invalidate_chat_settings`` / ``set_subagent_enabled`` handlers, session.py
~2161–2257) into an injectable collaborator. The per-account state it mutates
(``per_chat`` / ``idle_msg_count`` / the sub-agent tracker) and the DB cache
helpers are injected so the router is unit-testable with fakes — no live socket
/ DB. Behaviour is byte-for-byte identical to the original branch bodies.
"""
from __future__ import annotations

from typing import Callable

from ..log import setup_logging

logger = setup_logging()


class EventRouter:
  """Routes a single Node->Python control event to its cache-invalidation
  effect. ``handle`` carries the original branch bodies verbatim; injected
  dependencies mirror the names the closure bound."""

  def __init__(
    self,
    *,
    per_chat,
    idle_msg_count,
    subagent_tracker,
    reset_settings_connection: Callable[[], None],
    invalidate_chat_caches: Callable[[str], None],
    clear_llm2_model_cache: Callable[[str], None],
    set_llm2_model: Callable[[str, str], None],
    clear_subagent_enabled_cache: Callable[[str], None],
  ) -> None:
    self._per_chat = per_chat
    self._idle_msg_count = idle_msg_count
    self._subagent_tracker = subagent_tracker
    self._reset_settings_connection = reset_settings_connection
    self._invalidate_chat_caches = invalidate_chat_caches
    self._clear_llm2_model_cache = clear_llm2_model_cache
    self._set_llm2_model = set_llm2_model
    self._clear_subagent_enabled_cache = clear_subagent_enabled_cache

  async def handle(self, event) -> None:
    # Bind instance state + injected DB helpers to locals so the moved branch
    # bodies are byte-for-byte identical to the former ``_dispatch_event``.
    per_chat = self._per_chat
    idle_msg_count = self._idle_msg_count
    subagent_tracker = self._subagent_tracker
    db_reset_settings_connection = self._reset_settings_connection
    db_invalidate_chat_caches = self._invalidate_chat_caches
    db_clear_llm2_model_cache = self._clear_llm2_model_cache
    db_set_llm2_model = self._set_llm2_model
    db_clear_subagent_enabled_cache = self._clear_subagent_enabled_cache
    event_type = event.get("type")
    if event_type == "error":
      logger.warning("Gateway error: %s", event.get("payload"))
      return

    # Handle clear_history message from Node.js (after /reset). Node sends
    # this in addition to the /reset slash message itself; the inline
    # /reset handler in process_message_batch is the authoritative path,
    # but this hook still fires immediately so a follow-up message landing
    # before the debounce window expires can't see stale history.
    if event_type == "clear_history":
      clear_chat_id = event.get("chatId")
      if clear_chat_id == "global":
        per_chat.clear()
        idle_msg_count.clear()
        subagent_tracker.clear_all()
        db_reset_settings_connection()
        logger.info("History and caches cleared for ALL chats via clear_history message")
      elif clear_chat_id:
        per_chat[clear_chat_id].clear()
        idle_msg_count.pop(clear_chat_id, None)
        subagent_tracker.clear_history_for_chat(clear_chat_id)
        db_invalidate_chat_caches(clear_chat_id)
        logger.info("History cleared for chat_id=%s via clear_history message", clear_chat_id)
      return

    # Handle invalidate_llm2_model message from Node.js (after model change)
    if event_type == "invalidate_llm2_model":
      clear_chat_id = event.get("chatId")
      if clear_chat_id == "global":
        db_reset_settings_connection()
        logger.info("LLM2 model cache cleared for ALL chats via invalidate_llm2_model message")
      else:
        db_clear_llm2_model_cache(clear_chat_id)
        logger.info("LLM2 model cache cleared for chat_id=%s via invalidate_llm2_model message", clear_chat_id)
      return

    # Handle set_llm2_model message from Node.js (authoritative sync)
    if event_type == "set_llm2_model":
      chat_id = event.get("chatId")
      model_id = event.get("modelId")
      if chat_id == "global":
        db_reset_settings_connection()
        logger.info("LLM2 model set globally via set_llm2_model message model_id=%s", model_id)
      elif chat_id:
        db_set_llm2_model(chat_id, model_id)
        logger.info("LLM2 model set via set_llm2_model message chat_id=%s model_id=%s", chat_id, model_id)
      return

    # Handle invalidate_default_model message from Node.js (after modelcfg changes)
    if event_type == "invalidate_default_model":
      db_reset_settings_connection()
      logger.info("Settings DB connection reset and caches cleared via invalidate_default_model message")
      return

    # Handle set_subagent_enabled from Node.js (after /subagent on|off) so
    # the in-process cache (`_subagent_enabled_cache`) is dropped without
    # requiring a bridge restart. The new value will be re-read from
    # chat_settings.subagent_enabled on the next get_subagent_enabled call.
    if event_type == "set_subagent_enabled":
      chat_id = event.get("chatId")
      enabled = bool(event.get("enabled"))
      if chat_id == "global":
        db_reset_settings_connection()
        logger.info("subagent_enabled cache invalidated GLOBALLY")
      elif chat_id:
        db_clear_subagent_enabled_cache(chat_id)
        # Reset the settings DB connection too so SQLite re-reads the row
        # Node just wrote; without this, the cached connection may serve
        # the pre-write snapshot for the lifetime of the process.
        db_reset_settings_connection()
        logger.info(
          "subagent_enabled cache invalidated chat_id=%s enabled=%s",
          chat_id,
          enabled,
        )
      return

    # Handle invalidate_chat_settings from Node.js (after /mode, /prompt,
    # /permission, /trigger). Without this hook the bridge keeps serving
    # the pre-write cached value (mode/prompt/permission/triggers) until
    # the Python process is restarted, which is exactly the symptom users
    # report as "settings change doesn't take effect until restart".
    if event_type == "invalidate_chat_settings":
      chat_id = event.get("chatId")
      if chat_id == "global":
        db_reset_settings_connection()
        logger.info("chat settings caches invalidated GLOBALLY")
      elif chat_id:
        db_invalidate_chat_caches(chat_id)
        logger.info(
          "chat settings caches invalidated chat_id=%s",
          chat_id,
        )
      return
