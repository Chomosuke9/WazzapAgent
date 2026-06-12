"""``Llm1Router`` — the should-respond / express decision (Step 09).

Lifts the LLM1 *routing orchestration* out of the ``process_message_batch``
closure in ``session.py`` into an injectable collaborator. The actual model
call + prompt assembly + fallback/validation primitives stay in
``llm/llm1.py``; this class is a thin, testable seam over them.

``route()`` wraps :func:`bridge.llm.llm1.call_llm1` and returns the SAME
:class:`~bridge.llm.schemas.LLM1Decision` object the batch flow consumed before
(``should_response`` / ``confidence`` / ``reason`` / express fields). The
``call_llm1`` callable is injected so the router is unit-testable with a fake
(no network, no LLM SDK). Confidence/routing semantics and the
LLM1-skip-in-private-chat behaviour live unchanged in ``call_llm1`` and its
callers — this class does not alter them.
"""
from __future__ import annotations

from typing import Awaitable, Callable, Iterable, Optional

from ..history import WhatsAppMessage
from ..llm.llm1 import call_llm1 as _default_call_llm1
from ..llm.schemas import LLM1Decision


class Llm1Router:
  """Owns the LLM1 routing decision for one account.

  :param call_llm1: async callable with the same signature as
    :func:`bridge.llm.llm1.call_llm1`; defaults to that function. Injected so
    tests can pass a fake that returns a canned :class:`LLM1Decision`.
  """

  def __init__(
    self,
    *,
    call_llm1: Callable[..., Awaitable[LLM1Decision]] = _default_call_llm1,
  ) -> None:
    self._call_llm1 = call_llm1

  async def route(
    self,
    history: Iterable[WhatsAppMessage],
    current: WhatsAppMessage,
    *,
    current_payload: dict | None = None,
    group_description: str | None = None,
    prompt_override: str | None = None,
    **kwargs,
  ) -> LLM1Decision:
    """Run LLM1 and return its decision (unchanged shape).

    A direct passthrough to the injected ``call_llm1`` — kept as a method so
    the batch closure calls ``self._llm1.route(...)`` instead of the module
    global, and so the call is mockable in isolation. Extra keyword arguments
    (e.g. ``timeout``/``client``) are forwarded verbatim to ``call_llm1``.
    """
    return await self._call_llm1(
      history,
      current,
      current_payload=current_payload,
      group_description=group_description,
      prompt_override=prompt_override,
      **kwargs,
    )
