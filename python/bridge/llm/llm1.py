# File: python/bridge/llm/llm1.py
"""
LLM1 — Decision Router (Should the bot respond?)

This module implements the first stage of the two-LLM pipeline. LLM1 is a
cheap, fast model call that runs on every incoming message burst in group chats.
It produces exactly one of two tool-call decisions:

  1. `llm_should_response(should_response, confidence, reason)` —
     The primary routing decision. If `should_response=True`, the burst is
     forwarded to LLM2 for a full response. If `False`, the burst is skipped.

  2. `llm_react(emoji, context_msg_id, confidence, reason)` —
     An "express-only" emoji reaction instead of a text reply.

  3. `llm_sticker(sticker_name, context_msg_id, confidence, reason)` —
     An "express-only" sticker response instead of a text reply.

Why a separate router instead of a tool within LLM2?
  - Cost: ~70-80% of group messages don't need a full LLM2 response.
  - Latency: LLM1 is tuned for sub-2s; LLM2 can take 5-20s.
  - Isolation: LLM1's prompt is specialized for routing/confidence scoring.

If LLM1_ENDPOINT is empty, LLM1 is disabled and all messages go directly to LLM2.
Private chats always bypass LLM1 (confidence 100).

Fallback behavior: If the primary endpoint fails (timeout, error, invalid response),
the module tries the fallback endpoint (LLM1_FALLBACK_ENDPOINT). If both fail,
the message is skipped (should_response=False, confidence=10).
"""
from __future__ import annotations

import json
import time
import logging
import re
from typing import Iterable, Optional

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from pydantic import ValidationError

from .. import config
from ..history import WhatsAppMessage
from ..log import setup_logging, trunc, dump_json, env_flag
from ..media import build_visual_parts, llm1_media_enabled, redact_multimodal_content
from ..stickers import sticker_catalog_text
from .schemas import LLM1Decision, build_llm1_tools, LLM1_TOOL, LLM1_REACT_TOOL  # noqa: F401
from .client import (  # noqa: F401
  LLM1Target,
  _llm1_history_limit,
  _llm1_message_max_chars,
  _llm1_timeout,
  _llm1_sdk_max_retries,
  _llm1_temperature,
  _llm1_max_tokens,
  _clean_env,
  _endpoint_base_url,
  _chat_base_url,
  _llm1_targets,
  get_llm1,
)
from .prompt import (  # noqa: F401
  _truncate_text,
  _truncate_burst_text,
  _truncate_message,
  _render_prompt_override,
  _group_description_block,
  _format_current_window,
  build_llm1_prompt,
  _metadata_block,
)
from .error_utils import _is_timeout_error, _error_chain

logger = setup_logging()


def _prompt_to_langchain_messages(prompt: list[dict]) -> list[SystemMessage | HumanMessage]:
  messages: list[SystemMessage | HumanMessage] = []
  for item in prompt:
    if not isinstance(item, dict):
      continue
    role = str(item.get("role") or "").strip().lower()
    content = item.get("content", "")
    if role == "system":
      messages.append(SystemMessage(content=content))
    else:
      messages.append(HumanMessage(content=content))
  return messages


def _llm1_ctx(
  current: WhatsAppMessage,
  *,
  provider: str,
  model: str,
  url: str | None,
  current_payload: dict | None = None,
) -> dict:
  payload = current_payload if isinstance(current_payload, dict) else {}
  chat_id = payload.get("chatId") or payload.get("chat_id")
  raw_chat_type = str(payload.get("chatType") or payload.get("chat_type") or "").strip().lower()
  if raw_chat_type not in {"group", "private"}:
    if isinstance(chat_id, str) and chat_id.endswith("@g.us"):
      raw_chat_type = "group"
    else:
      raw_chat_type = "group" if bool(payload.get("isGroup")) else "private"
  chat_name = (payload.get("chatName") or payload.get("chat_name")) if raw_chat_type == "group" else None
  return {
    "chat_id": chat_id or getattr(current, "sender", None),
    "chat_name": chat_name,
    "message_id": getattr(current, "message_id", None) or getattr(current, "id", None),
    "provider": provider,
    "model": model,
    "endpoint": url,
  }


def _log_llm1_decision(
  decision: LLM1Decision,
  *,
  ctx: dict,
  elapsed_ms: int,
  source: str,
) -> None:
  status = "respond" if decision.should_response else "skip"
  reason_text = trunc(" ".join((decision.reason or "").split()), 220)
  logger.info(
    'LLM1 decision final (%s): %s conf=%s%% reason="%s" elapsed=%sms',
    source,
    status,
    decision.confidence,
    reason_text,
    elapsed_ms,
    extra={
      **ctx,
      "source": source,
      "should_response": decision.should_response,
      "confidence": decision.confidence,
      "reason": decision.reason,
      "elapsed_ms": elapsed_ms,
      "raw": trunc(dump_json(decision.model_dump()), 400),
    },
  )


from .tool_utils import extract_tool_args as _extract_tool_args, get_tool_call_name as _get_tool_call_name  # noqa: E305


def _content_to_text(content) -> str:
  if isinstance(content, str):
    return content
  if isinstance(content, list):
    parts: list[str] = []
    for item in content:
      if not isinstance(item, dict):
        parts.append(str(item))
        continue
      if item.get("type") == "text":
        parts.append(str(item.get("text") or ""))
        continue
      if item.get("type") == "image_url":
        parts.append("[image]")
        continue
      parts.append(f"[{item.get('type') or 'part'}]")
    return "\n".join(parts)
  return str(content)


def _extract_decision_from_content(content) -> dict:
  text = _content_to_text(content).strip()
  if not text:
    return {}

  candidates: list[str] = [text]
  fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, re.IGNORECASE)
  if fenced:
    fenced_text = fenced.group(1).strip()
    if fenced_text:
      candidates.append(fenced_text)

  first_brace = text.find("{")
  last_brace = text.rfind("}")
  if first_brace >= 0 and last_brace > first_brace:
    candidates.append(text[first_brace : last_brace + 1].strip())

  for candidate in candidates:
    try:
      parsed = json.loads(candidate)
    except Exception:
      continue
    if isinstance(parsed, dict):
      return parsed
  return {}


def _redact_messages_for_log(messages: list[dict]) -> list[dict]:
  redacted: list[dict] = []
  for msg in messages:
    if not isinstance(msg, dict):
      continue
    copied = dict(msg)
    copied["content"] = redact_multimodal_content(copied.get("content"))
    redacted.append(copied)
  return redacted


async def call_llm1(
  history: Iterable[WhatsAppMessage],
  current: WhatsAppMessage,
  *,
  timeout: float = 8.0,
  client: Optional[ChatOpenAI] = None,
  current_payload: dict | None = None,
  group_description: str | None = None,
  prompt_override: str | None = None,
) -> LLM1Decision:
  primary_endpoint = config.llm1_endpoint_base_url()
  fallback_endpoint = config.llm1_fallback_endpoint_base_url()
  # If LLM1 is not configured, allow responding by default.
  if not primary_endpoint and not fallback_endpoint:
    logger.debug("LLM1 disabled (no LLM1_ENDPOINT set); defaulting to respond")
    return LLM1Decision(should_response=True, confidence=50, reason="llm1_disabled")

  targets = _llm1_targets()
  if client is not None and targets:
    targets = targets[:1]
  if not targets:
    logger.debug("LLM1 endpoint missing after normalization; defaulting to skip")
    return LLM1Decision(should_response=False, confidence=10, reason="llm1_missing_url")

  history_limit = _llm1_history_limit()
  message_max_chars = _llm1_message_max_chars()
  llm1_chat_id = current_payload.get("chatId") or current_payload.get("chat_id") if isinstance(current_payload, dict) else None
  llm1_tools = build_llm1_tools()
  history_list = list(history)
  prompt_history = history_list[-history_limit:]
  current_media_parts: list[dict] = []
  current_media_notes: list[str] = []
  if llm1_media_enabled():
    current_media_parts, current_media_notes = build_visual_parts(current_payload)
  sticker_catalog = sticker_catalog_text(llm1_chat_id) if llm1_chat_id else sticker_catalog_text()
  prompt = build_llm1_prompt(
    prompt_history,
    current,
    history_limit=history_limit,
    message_max_chars=message_max_chars,
    current_media_parts=current_media_parts,
    current_media_notes=current_media_notes,
    metadata_block=_metadata_block(current_payload),
    group_description=group_description,
    prompt_override=prompt_override,
    sticker_catalog=sticker_catalog,
  )
  prompt_text = "\n".join(
    [_content_to_text(m.get("content", "")) for m in prompt if isinstance(m, dict)]
  )

  last_failure: LLM1Decision | None = None
  total_targets = len(targets)
  llm1_temperature = _llm1_temperature()
  llm1_max_tokens = _llm1_max_tokens()

  for idx, target in enumerate(targets):
    has_next_target = idx < (total_targets - 1)
    t0 = time.perf_counter()
    ctx = _llm1_ctx(
      current,
      provider=target.name,
      model=target.model,
      url=target.base_url,
      current_payload=current_payload,
    )
    llm = client if (client is not None and idx == 0) else get_llm1(
      model=target.model,
      base_url=target.base_url,
      api_key=target.api_key,
      timeout=timeout,
    )

    if env_flag("BRIDGE_LOG_PROMPT_FULL"):
      logger.info(
        "LLM1 prompt full",
        extra={
          **ctx,
          "history_limit": history_limit,
          "history_used": len(prompt_history),
          "message_max_chars": message_max_chars,
          "base_url": target.base_url,
          "media_parts": len(current_media_parts),
          "messages": _redact_messages_for_log(prompt),
        },
      )

    logger.info(
      "LLM1 invoke start (model=%s, history=%s)",
      target.model,
      len(prompt_history),
      extra={
        **ctx,
        "history_used": len(prompt_history),
        "media_parts": len(current_media_parts),
        "temperature": llm1_temperature,
        "max_tokens": llm1_max_tokens,
      },
    )

    logger.debug(
      "LLM1 request start",
      extra={
        **ctx,
        "history_limit": history_limit,
        "history_used": len(prompt_history),
        "message_max_chars": message_max_chars,
        "timeout_s": _llm1_timeout(timeout),
        "prompt_chars": len(prompt_text),
        "prompt_preview": trunc(prompt_text, 300),
        "media_parts": len(current_media_parts),
        "base_url": target.base_url,
        "temperature": llm1_temperature,
        "max_tokens": llm1_max_tokens,
        "tool_names": [t["function"]["name"] for t in llm1_tools],
      },
    )

    async def _invoke_once(llm_client: ChatOpenAI):
      try:
        # Use "auto" instead of "required" — some providers (e.g. Moonshot/Kimi
        # with thinking enabled) reject tool_choice="required" with a 400 error.
        llm_with_tool = llm_client.bind_tools(
          llm1_tools,
          tool_choice="auto",
        )
      except Exception as err:
        logger.warning(
          "LLM1 bind_tools with tool_choice=%s failed; retrying default bind_tools",
          "auto",
          exc_info=err,
          extra={
            **ctx,
            "error_type": type(err).__name__,
          },
        )
        llm_with_tool = llm_client.bind_tools(llm1_tools)
      return await llm_with_tool.ainvoke(_prompt_to_langchain_messages(prompt))

    try:
      response = await _invoke_once(llm)
    except Exception as err:
      elapsed_ms = int((time.perf_counter() - t0) * 1000)
      timeout_error = _is_timeout_error(err)
      logger.error(
        "LLM1 invoke failed",
        exc_info=True,
        extra={
          **ctx,
          "elapsed_ms": elapsed_ms,
          "error_type": type(err).__name__,
          "error_chain": _error_chain(err),
          "will_try_fallback_target": has_next_target,
        },
      )
      last_failure = LLM1Decision(
        should_response=False,
        confidence=10,
        reason="llm1_unreachable" if timeout_error else "llm1_exception",
      )
      if has_next_target:
        logger.warning(
          "LLM1 provider failed; trying fallback target",
          extra={
            **ctx,
            "next_provider": targets[idx + 1].name,
          },
        )
        continue
      return last_failure

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    response_metadata = getattr(response, "response_metadata", None)
    usage_metadata = getattr(response, "usage_metadata", None)
    _llm1_input_tokens = 0
    _llm1_output_tokens = 0
    if isinstance(usage_metadata, dict):
      _llm1_input_tokens = usage_metadata.get("input_tokens", 0) or 0
      _llm1_output_tokens = usage_metadata.get("output_tokens", 0) or 0
    raw_tool_calls = getattr(response, "tool_calls", None) or []
    content = getattr(response, "content", None)
    additional_kwargs = getattr(response, "additional_kwargs", {}) or {}
    if not raw_tool_calls and isinstance(additional_kwargs, dict):
      maybe_tool_calls = additional_kwargs.get("tool_calls")
      if isinstance(maybe_tool_calls, list):
        raw_tool_calls = maybe_tool_calls

    logger.debug(
      "LLM1 response received",
      extra={
        **ctx,
        "elapsed_ms": elapsed_ms,
        "response_metadata": response_metadata,
        "usage": usage_metadata,
        "tool_calls_count": len(raw_tool_calls),
        "content_preview": trunc(_content_to_text(content), 600),
      },
    )

    if logger.isEnabledFor(logging.DEBUG):
      logger.debug(
        "LLM1 raw response",
        extra={
          **ctx,
          "raw": dump_json(getattr(response, "model_dump", lambda: str(response))()),
        },
      )

    tool_calls = raw_tool_calls or []
    if not tool_calls:
      parsed_fallback = _extract_decision_from_content(content)
      if parsed_fallback:
        try:
          decision = LLM1Decision.model_validate(parsed_fallback)
          logger.warning(
            "LLM1 response missing tool call; parsed JSON fallback",
            extra={
              **ctx,
              "response_metadata": response_metadata,
              "fallback_args": parsed_fallback,
            },
          )
          decision.input_tokens = _llm1_input_tokens
          decision.output_tokens = _llm1_output_tokens
          _log_llm1_decision(
            decision,
            ctx=ctx,
            elapsed_ms=elapsed_ms,
            source="json_fallback",
          )
          return decision
        except ValidationError:
          pass
      logger.warning(
        "LLM1 response missing tool call",
        extra={
          **ctx,
          "response_metadata": response_metadata,
          "will_try_fallback_target": has_next_target,
        },
      )
      last_failure = LLM1Decision(should_response=False, confidence=10, reason="llm1_no_tool")
      if has_next_target:
        logger.warning(
          "LLM1 invalid response shape; trying fallback target",
          extra={
            **ctx,
            "next_provider": targets[idx + 1].name,
          },
        )
        continue
      return last_failure

    # Detect which tool was called: llm_should_response, llm_react, or llm_sticker
    respond_tool_name = LLM1_TOOL["function"]["name"]
    react_tool_name = LLM1_REACT_TOOL["function"]["name"]
    sticker_tool_names = {t["function"]["name"] for t in llm1_tools if t["function"]["name"].startswith("llm_sticker")}
    react_tool_names = {respond_tool_name, react_tool_name} | sticker_tool_names

    # Find the first recognized tool call
    tool_call = None
    called_tool_name = None
    for tc in tool_calls:
      tc_name = _get_tool_call_name(tc)
      if tc_name in react_tool_names:
        tool_call = tc
        called_tool_name = tc_name
        break
    if tool_call is None:
      tool_call = tool_calls[0]
      called_tool_name = _get_tool_call_name(tool_call)

    args = _extract_tool_args(tool_call)
    if not args:
      logger.warning(
        "LLM1 tool args empty",
        extra={
          **ctx,
          "raw_tool_call": trunc(str(tool_call), 500),
          "will_try_fallback_target": has_next_target,
        },
      )
      last_failure = LLM1Decision(should_response=False, confidence=10, reason="llm1_empty_tool")
      if has_next_target:
        logger.warning(
          "LLM1 invalid tool args; trying fallback target",
          extra={
            **ctx,
            "next_provider": targets[idx + 1].name,
          },
        )
        continue
      return last_failure

    # Handle llm_react or llm_sticker tool call
    if called_tool_name == react_tool_name or called_tool_name in sticker_tool_names:
      if called_tool_name in sticker_tool_names:
        # llm_sticker: expression is the sticker_name
        react_expression = str(args.get("sticker_name") or "").strip()
      else:
        # llm_react: expression is the emoji
        react_expression = str(args.get("emoji") or "").strip()
      react_context_msg_id = str(args.get("context_msg_id") or "").strip()
      react_confidence = args.get("confidence", 50)
      react_reason = str(args.get("reason") or "express-only").strip()
      if not react_expression or not react_context_msg_id:
        logger.warning(
          "LLM1 %s missing expression or context_msg_id",
          called_tool_name,
          extra={**ctx, "raw_args": args, "will_try_fallback_target": has_next_target},
        )
        last_failure = LLM1Decision(should_response=False, confidence=10, reason="llm1_invalid_express_tool")
        if has_next_target:
          continue
        return last_failure
      decision = LLM1Decision(
        should_response=False,
        confidence=react_confidence if isinstance(react_confidence, int) else 50,
        reason=react_reason[:320],
        react_expression=react_expression,
        react_context_msg_id=react_context_msg_id,
        input_tokens=_llm1_input_tokens,
        output_tokens=_llm1_output_tokens,
      )
      logger.info(
        'LLM1 express decision: expression=%s target=%s conf=%s%% reason="%s" elapsed=%sms',
        react_expression,
        react_context_msg_id,
        decision.confidence,
        trunc(" ".join((decision.reason or "").split()), 220),
        elapsed_ms,
        extra={
          **ctx,
          "source": "express_tool_call",
          "tool_name": called_tool_name,
          "should_response": False,
          "react_expression": react_expression,
          "react_context_msg_id": react_context_msg_id,
          "confidence": decision.confidence,
          "reason": decision.reason,
          "elapsed_ms": elapsed_ms,
        },
      )
      return decision

    # Handle llm_should_response tool call (existing behavior)
    try:
      decision = LLM1Decision.model_validate(args)
    except ValidationError as err:
      logger.warning(
        "LLM1 tool args failed validation",
        exc_info=err,
        extra={**ctx, "raw_args": args, "will_try_fallback_target": has_next_target},
      )
      last_failure = LLM1Decision(should_response=False, confidence=10, reason="llm1_invalid_tool")
      if has_next_target:
        logger.warning(
          "LLM1 invalid tool args; trying fallback target",
          extra={
            **ctx,
            "next_provider": targets[idx + 1].name,
          },
        )
        continue
      return last_failure

    decision.input_tokens = _llm1_input_tokens
    decision.output_tokens = _llm1_output_tokens
    _log_llm1_decision(
      decision,
      ctx=ctx,
      elapsed_ms=elapsed_ms,
      source="tool_call",
    )
    return decision

  return last_failure or LLM1Decision(should_response=False, confidence=10, reason="llm1_exception")
