"""Canonical LLM invocation-context assembly for every LLM2 entry point.

The final prompt renderer lives in :mod:`bridge.llm.llm2`.  This module owns
the previously duplicated step immediately before it: resolve trusted chat
metadata, prompt override, and long-term memory into one immutable bundle.

Inbound message paths already carry an authoritative gateway payload and use
``from_payload``.  Cold/background paths (scheduled/daily tasks, direct invoke,
and completed sub-agents) use ``build(..., refresh_live=True)`` so they query
the gateway instead of fabricating admin state.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from ..llm.prompt import build_memory_block, render_stored_mentions
from ..log import setup_logging


logger = setup_logging()


def _clean(value) -> str:
  return value.strip() if isinstance(value, str) else ""


@dataclass(frozen=True)
class LlmInvocationContext:
  """All chat-scoped inputs consumed by the canonical LLM2 prompt builder."""

  chat_id: str
  current_payload: dict
  group_description: str | None
  prompt_override: str | None
  chat_type: str
  bot_is_admin: bool
  bot_is_super_admin: bool
  memory_block: str | None

  def generation_kwargs(self) -> dict:
    """Return the shared keyword arguments for ``Llm2Responder.generate``."""
    return {
      "current_payload": self.current_payload,
      "group_description": self.group_description,
      "prompt_override": self.prompt_override,
      "chat_type": self.chat_type,
      "bot_is_admin": self.bot_is_admin,
      "bot_is_super_admin": self.bot_is_super_admin,
      "memory_block": self.memory_block,
    }


class LlmContextBuilder:
  """Build one trusted :class:`LlmInvocationContext` for every LLM2 path."""

  _LIVE_KEYS = (
    "chatId",
    "chatName",
    "chatType",
    "isGroup",
    "groupDescription",
    "botIsAdmin",
    "botIsSuperAdmin",
  )

  def __init__(
    self,
    *,
    ws=None,
    get_prompt: Optional[Callable[[str], Optional[str]]] = None,
    memory_builder: Callable[[str], Optional[str]] = build_memory_block,
  ) -> None:
    self._ws = ws
    self._get_prompt = get_prompt
    self._memory_builder = memory_builder

  def from_payload(
    self,
    chat_id: str,
    payload: dict | None = None,
  ) -> LlmInvocationContext:
    """Build from an already trusted gateway payload without network I/O."""
    resolved_payload = dict(payload or {})
    resolved_payload["chatId"] = chat_id

    raw_chat_type = _clean(resolved_payload.get("chatType")).lower()
    if raw_chat_type not in {"private", "group"}:
      raw_chat_type = "group" if (
        bool(resolved_payload.get("isGroup")) or chat_id.endswith("@g.us")
      ) else "private"
    resolved_payload["chatType"] = raw_chat_type
    resolved_payload["isGroup"] = raw_chat_type == "group"

    group_description = (
      _clean(resolved_payload.get("groupDescription")) or None
      if raw_chat_type == "group"
      else None
    )

    prompt_override = None
    if self._get_prompt is not None:
      try:
        prompt_override = render_stored_mentions(
          self._get_prompt(chat_id), chat_id,
        )
      except Exception:  # pylint: disable=broad-except
        logger.exception(
          "LLM context: failed to resolve prompt override",
          extra={"chat_id": chat_id},
        )

    memory_block = None
    try:
      memory_block = self._memory_builder(chat_id)
    except Exception:  # pylint: disable=broad-except
      logger.exception(
        "LLM context: failed to build memory block",
        extra={"chat_id": chat_id},
      )

    return LlmInvocationContext(
      chat_id=chat_id,
      current_payload=resolved_payload,
      group_description=group_description,
      prompt_override=prompt_override,
      chat_type=raw_chat_type,
      bot_is_admin=bool(resolved_payload.get("botIsAdmin")),
      bot_is_super_admin=bool(resolved_payload.get("botIsSuperAdmin")),
      memory_block=memory_block,
    )

  async def build(
    self,
    chat_id: str,
    payload: dict | None = None,
    *,
    refresh_live: bool = False,
  ) -> LlmInvocationContext:
    """Build context, optionally overlaying a live authoritative snapshot.

    A failed live lookup intentionally falls back to the supplied payload.  If
    there is no payload, the fallback remains fail-closed (non-admin) while the
    invocation itself can still deliver a reminder or direct message.
    """
    resolved_payload = dict(payload or {})
    if refresh_live:
      getter = getattr(self._ws, "get_chat_context", None)
      if getter is None:
        logger.warning(
          "LLM context: gateway does not expose get_chat_context; using fallback",
          extra={"chat_id": chat_id},
        )
      else:
        try:
          live = await getter(chat_id, force_refresh=True)
          if isinstance(live, dict):
            for key in self._LIVE_KEYS:
              if key in live:
                resolved_payload[key] = live[key]
        except Exception as err:  # pylint: disable=broad-except
          logger.warning(
            "LLM context: live snapshot failed chat_id=%s: %s",
            chat_id,
            err,
            extra={"chat_id": chat_id},
          )
    return self.from_payload(chat_id, resolved_payload)


__all__ = ["LlmContextBuilder", "LlmInvocationContext"]
