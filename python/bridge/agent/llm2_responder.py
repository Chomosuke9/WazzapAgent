"""``Llm2Responder`` — reply generation + result validation (Step 09).

Lifts LLM2 *generation orchestration* and the ``_validate_llm2_result`` closure
(session.py ~1147) out of ``process_message_batch`` into an injectable
collaborator. The actual model call, dynamic tool/prompt building, multimodal
handling and fallback live in :func:`bridge.llm.llm2.generate_reply`; this class
is a thin, testable seam over them.

``generate()`` is a passthrough to ``generate_reply`` (returns the SAME
``AIMessage`` / ``None`` result the batch flow consumed before).
``make_validator()`` rebuilds the former per-batch ``_validate_llm2_result``
closure — it returns ``True`` iff the model output yields at least one usable
action — using the injected action-extraction functions, so it is unit-testable
with fakes and behaviour is byte-identical to the original closure.

Tool schemas are NOT changed here: ``generate_reply`` still builds them
dynamically from permissions when ``tools is None`` (unchanged). The schema
builder is accepted for injection/visibility but defaults to the real one.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Iterable, Optional

from ..history import WhatsAppMessage
from ..llm.llm2 import generate_reply as _default_generate_reply
from ..llm.schemas import build_llm2_tools as _default_build_llm2_tools
from ..messaging.actions import _extract_actions as _default_extract_actions
from ..messaging.actions import (
  _extract_actions_from_tool_calls as _default_extract_actions_from_tool_calls,
)


class Llm2Responder:
  """Owns LLM2 reply generation + output validation for one account.

  :param generate_reply: async callable with the same signature as
    :func:`bridge.llm.llm2.generate_reply`; defaults to that function.
  :param extract_actions_from_tool_calls: callable used by the validator to
    turn tool-calls into action dicts (defaults to the messaging helper).
  :param extract_actions: callable used by the validator's legacy text-content
    fallback (defaults to the messaging helper).
  :param build_tools: tool-schema builder (kept for injection/visibility;
    ``generate_reply`` itself decides whether to call it). NOT used to alter
    schemas.
  """

  def __init__(
    self,
    *,
    generate_reply: Callable[..., Awaitable] = _default_generate_reply,
    extract_actions_from_tool_calls: Callable[..., list] = _default_extract_actions_from_tool_calls,
    extract_actions: Callable[..., list] = _default_extract_actions,
    build_tools: Callable[..., list] = _default_build_llm2_tools,
  ) -> None:
    self._generate_reply = generate_reply
    self._extract_actions_from_tool_calls = extract_actions_from_tool_calls
    self._extract_actions = extract_actions
    self._build_tools = build_tools

  def validate_result(
    self,
    result,
    *,
    fallback_reply_to: str | None,
    allowed_context_ids,
  ) -> bool:
    """Return True if the LLM2 output contains at least one usable action.

    Byte-identical to the former ``_validate_llm2_result`` closure: prefer the
    tool-call path, fall back to parsing text content (legacy).
    """
    tool_calls = getattr(result, 'tool_calls', None) or []
    if tool_calls:
      test_actions = self._extract_actions_from_tool_calls(
        tool_calls,
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )
      return len(test_actions) > 0
    # Fallback: parse text content (legacy)
    test_actions = self._extract_actions(
      result,
      fallback_reply_to=fallback_reply_to,
      allowed_context_ids=allowed_context_ids,
    )
    return len(test_actions) > 0

  def make_validator(
    self,
    *,
    fallback_reply_to: str | None,
    allowed_context_ids,
  ) -> Callable[[object], bool]:
    """Build the per-batch ``result_validator`` callable passed to
    :meth:`generate`. Closes over the batch-local ``fallback_reply_to`` /
    ``allowed_context_ids`` exactly as the original closure did."""

    def _validate_llm2_result(result) -> bool:
      return self.validate_result(
        result,
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )

    return _validate_llm2_result

  async def generate(
    self,
    history: Iterable[WhatsAppMessage],
    current: WhatsAppMessage,
    **kwargs,
  ):
    """Generate an LLM2 reply (unchanged result shape).

    Direct passthrough to the injected ``generate_reply`` — kept as a method so
    the batch / sub-agent closures call ``self._llm2.generate(...)`` instead of
    the module global, and so the call is mockable in isolation. All keyword
    arguments (``current_payload``, ``result_validator``, ``allow_subagent``,
    ``subagent_context``, ``subagent_result_block``, …) are forwarded verbatim.
    """
    return await self._generate_reply(history, current, **kwargs)
