from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Iterable, Optional

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from .. import config
from ..config import (
    _endpoint_base_url,
)
from ..db import (
    get_default_llm2_model,
    get_model_vision_support,
    permission_allows_delete,
    permission_allows_kick,
    permission_allows_mute,
)
from ..db import get_llm2_model as db_get_llm2_model
from ..db import get_permission as db_get_permission
from ..history import WhatsAppMessage, format_history
from ..log import dump_json, env_flag, setup_logging, trunc
from ..media import build_visual_parts, redact_multimodal_content
from ..stickers import sticker_catalog_text
from .error_utils import _error_chain, _is_timeout_error
from .prompt import (  # noqa: F401
    _chat_state_header,
    _context_injection_block,
    _current_date_str,
    _files_for_subagent_block,
    _format_current_window,
    _group_description_block,
    _load_system_prompt,
    _normalize_chat_type,
    _render_system_prompt,
    _truncate_message,
)
from .schemas import build_llm2_tools

logger = setup_logging()


@dataclass(frozen=True)
class LLM2Target:
    name: str
    model: str
    base_url: str | None
    api_key: str


def _llm2_message_max_chars() -> int:
    return config.llm2_message_max_chars()


def _llm2_timeout() -> float:
    return config.llm2_timeout()


def _llm2_retry_max() -> int:
    return config.llm2_retry_max()


def _llm2_retry_backoff_seconds() -> float:
    return config.llm2_retry_backoff_seconds()


def _llm2_sdk_max_retries() -> int:
    return config.llm2_sdk_max_retries()


def get_llm2_model_for_chat(chat_id: str) -> str:
    """Get model_id for chat, or default if not set."""
    model_id = db_get_llm2_model(chat_id)
    default_model = get_default_llm2_model()
    default_model_id = default_model["model_id"] if default_model else "gpt-4.1"
    if model_id:
        logger.debug(
            "LLM2 model resolved from chat setting",
            extra={
                "chat_id": chat_id,
                "chat_model": model_id,
                "default_model": default_model_id,
                "resolved_model": model_id,
            },
        )
        return model_id
    logger.debug(
        "LLM2 model resolved from default setting",
        extra={
            "chat_id": chat_id,
            "chat_model": None,
            "default_model": default_model_id,
            "resolved_model": default_model_id,
        },
    )
    return default_model_id


def _llm2_targets() -> list[LLM2Target]:
    primary_model = config.llm2_model_clean() or "gpt-4.1"
    primary_endpoint = config.llm2_endpoint_base_url()
    primary_api_key = config.llm2_api_key_clean() or ""

    targets = [
        LLM2Target(
            name="primary",
            model=primary_model,
            base_url=primary_endpoint,
            api_key=primary_api_key,
        )
    ]

    fallback_model_raw = config.llm2_fallback_model_clean()
    fallback_endpoint_raw = config.llm2_fallback_endpoint_clean()
    fallback_api_key_raw = config.llm2_fallback_api_key_clean()
    fallback_enabled = any((fallback_model_raw, fallback_endpoint_raw, fallback_api_key_raw))
    if not fallback_enabled:
        return targets

    fallback_endpoint = (
        _endpoint_base_url(fallback_endpoint_raw) if fallback_endpoint_raw is not None else primary_endpoint
    )
    fallback_target = LLM2Target(
        name="fallback",
        model=fallback_model_raw or primary_model,
        base_url=fallback_endpoint,
        api_key=fallback_api_key_raw if fallback_api_key_raw is not None else primary_api_key,
    )

    primary_target = targets[0]
    if (
        fallback_target.model == primary_target.model
        and fallback_target.base_url == primary_target.base_url
        and fallback_target.api_key == primary_target.api_key
    ):
        return targets

    targets.append(fallback_target)
    return targets


def get_llm2(
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
) -> ChatOpenAI:
    resolved_model = model or (config.llm2_model_clean() or "gpt-4.1")
    temperature = float(config.llm2_temperature_raw())
    timeout = _llm2_timeout()
    max_retries = _llm2_sdk_max_retries()
    resolved_base_url = base_url if base_url is not None else config.llm2_endpoint_base_url()
    resolved_api_key = api_key if api_key is not None else (config.llm2_api_key_clean() or "")
    kwargs = {
        "model": resolved_model,
        "temperature": temperature,
        "base_url": resolved_base_url,
        "api_key": resolved_api_key,
        "timeout": timeout,
        "max_retries": max_retries,
    }
    return ChatOpenAI(
        **kwargs,
    )


def _resolve_llm2_chat_id(current_payload: dict | None, current: WhatsAppMessage) -> str | None:
    """Resolve the chat id LLM2 logs/keys against (payload first, else sender)."""
    payload = current_payload if isinstance(current_payload, dict) else {}
    return payload.get("chatId") or payload.get("chat_id") or current.sender


def _compute_llm2_permissions(
    chat_id: str | None, bot_is_admin: bool, bot_is_super_admin: bool
) -> tuple[bool, bool, bool]:
    """Return ``(can_delete, can_mute, can_kick)`` for dynamic tool/prompt gating.

    Shared by :func:`generate_reply` (tool gating) and
    :func:`build_llm2_messages` (system-prompt rule injection) so the two can
    never drift apart.
    """
    admin_ok = bool(bot_is_admin or bot_is_super_admin)
    perm_level = db_get_permission(chat_id) if chat_id else 0
    return (
        admin_ok and permission_allows_delete(perm_level),
        admin_ok and permission_allows_mute(perm_level),
        admin_ok and permission_allows_kick(perm_level),
    )


@dataclass(frozen=True)
class BuiltLlm2Prompt:
    """The exact prompt LLM2 is invoked with, plus a few derived log helpers.

    ``messages`` is the real ``list`` of LangChain messages sent to the model;
    ``text_fallback_messages`` is the text-only variant used when a multimodal
    invocation fails. Everything else is computed metadata reused for
    logging/preview so callers don't recompute it.
    """

    messages: list
    text_fallback_messages: list
    rendered_system: str
    history_list: list
    prompt_preview: str
    media_part_count: int


def build_llm2_messages(
    history: Iterable[WhatsAppMessage],
    current: WhatsAppMessage,
    *,
    system: str | None = None,
    prompt_override: str | None = None,
    current_payload: dict | None = None,
    group_description: str | None = None,
    chat_type: str | None = None,
    bot_is_admin: bool = False,
    bot_is_super_admin: bool = False,
    allow_subagent: bool = False,
    subagent_context: str | None = None,
    subagent_result_block: str | None = None,
    scheduled_task_block: str | None = None,
    memory_block: str | None = None,
) -> BuiltLlm2Prompt:
    """Build the EXACT message list LLM2 is invoked with.

    This is the single source of truth for the LLM2 prompt: the rendered system
    prompt, the group-description block, the context/helper injection, the
    sub-agent state block + ``execute_subtask`` file-ID helper, the optional
    re-invoke / scheduled-task slots, and finally the older-messages + current
    burst (with any visual attachments). :func:`generate_reply` calls this to
    talk to the model; ``/dump`` calls it (via :func:`serialize_llm2_messages`)
    so the dumped context is byte-for-byte what the model actually sees instead
    of a hand-rebuilt approximation.
    """
    log_chat_id = _resolve_llm2_chat_id(current_payload, current)
    can_delete, can_mute, can_kick = _compute_llm2_permissions(log_chat_id, bot_is_admin, bot_is_super_admin)
    sticker_catalog = sticker_catalog_text(log_chat_id) if log_chat_id else sticker_catalog_text()
    base_system = (system or _load_system_prompt()).strip()
    rendered_system = _render_system_prompt(
        base_system,
        prompt_override=prompt_override,
        allow_delete=can_delete,
        allow_mute=can_mute,
        allow_kick=can_kick,
        allow_subagent=allow_subagent,
        sticker_catalog=sticker_catalog,
        chat_type=chat_type,
    )
    history_list = list(history)
    message_max_chars = _llm2_message_max_chars()
    if message_max_chars > 0:
        history_list = [_truncate_message(msg, message_max_chars) for msg in history_list]
        current = _truncate_message(current, message_max_chars)
    hist_text = format_history(history_list, history=history_list, trim_quoted=True) or "(no older messages)"
    current_line = _format_current_window(current) or "(no current messages)"
    group_text = _group_description_block(group_description)
    context_injection = _context_injection_block(
        current_payload,
        chat_type=chat_type or "private",
        bot_is_admin=bot_is_admin,
        bot_is_super_admin=bot_is_super_admin,
        chat_id=log_chat_id,
    )
    messages_content_text = f"""older messages:\n{hist_text}\n\n
    <reasoning>
    Before you act, examine the LATEST message in `Current messages (burst)` FIRST, then answer EACH of these to yourself in your thinking — never in your reply `text`:
    1. What is the latest message actually saying/asking? (read its SENDER line, not the REPLYING TO line.)
    2. What does the sender actually want — and am I replying to the right person in a multi-party thread? Should I just leave it to not reply someone by just sending reaction or sticker?
    3. Does answering it need a tool, command, or sub-agent — or is text alone enough? If yes, what's the rule for using these things?
    4. Which exact `context_msg_id` and `senderRef` do I target? (copy them; do not guess. Wrong target ID is the #1 failure.)
    5. Does anything in `<long_term_memory>`, group state, or chat-state (private/group) change my answer?
    Only after answering all five do you produce your tool call. DO NOT produce a tool call before you answer ALL of them. No exception.
    </reasoning>\n
    current messages(burst):\n{current_line}"""
    media_parts: list[dict] = []
    media_notes: list[str] = []
    model_has_vision = get_model_vision_support(log_chat_id) if log_chat_id else False
    logger.info(
        "LLM2 vision check: chat_id=%s model_vision=%s will_send_media=%s",
        log_chat_id,
        model_has_vision,
        model_has_vision,
    )
    if model_has_vision:
        media_parts, media_notes = build_visual_parts(current_payload)
    if media_notes:
        messages_content_text += "\n\nVisual attachments:\n" + "\n".join(f"- {note}" for note in media_notes)

    messages_content: str | list[dict]
    if media_parts:
        messages_content = [{"type": "text", "text": messages_content_text}]
        messages_content.extend(media_parts)
    else:
        messages_content = messages_content_text

    # Final prompt order, in the sequence the model actually sees them:
    #   1) system        : system prompt
    #   2) user          : group description
    #   3) user          : helper / context injection
    #   4) user          : sub-agent task block  (only when allow_subagent /
    #                      subagent_context is provided for this chat)
    #   5) user          : sub-agent execute_subtask file-ID helper
    #                      (only when allow_subagent and the chat has files)
    #   6) user          : sub-agent FINISHED-this-turn block (re-invoke only)
    #   7) user          : scheduled-task block (scheduled cold-fire only)
    #   8) user          : older messages + current burst
    msgs: list[SystemMessage | HumanMessage] = [SystemMessage(content=rendered_system)]
    msgs.append(HumanMessage(content=f"Group description:\n{group_text}"))
    msgs.append(HumanMessage(content=context_injection))
    # Long-term memory (the /memory command): durable per-chat facts injected as
    # a standing block every turn, right after the helper/context injection so
    # the model always sees it (independent of the older-messages window).
    if memory_block:
        msgs.append(HumanMessage(content=memory_block))
    subagent_block: str | None = subagent_context if subagent_context else None
    if subagent_block:
        msgs.append(HumanMessage(content=subagent_block))
    files_block = (
        _files_for_subagent_block(history_list, current_payload=current_payload)
        if allow_subagent
        else None
    )
    if files_block:
        msgs.append(HumanMessage(content=files_block))
    if subagent_result_block:
        msgs.append(HumanMessage(content=subagent_result_block))
    if scheduled_task_block:
        msgs.append(HumanMessage(content=scheduled_task_block))
    msgs.append(HumanMessage(content=messages_content))

    # Text-only fallback used when a multimodal invoke fails: identical to the
    # primary message list but without the visual parts (``messages_content_text``
    # instead of the multimodal ``messages_content``). NOTE: this mirrors the
    # long-standing behaviour where the file-ID helper (``files_block``) is not
    # repeated in the fallback.
    text_fallback_msgs = [
        SystemMessage(content=rendered_system),
        HumanMessage(content=f"Group description:\n{group_text}"),
        HumanMessage(content=context_injection),
    ]
    if memory_block:
        text_fallback_msgs.append(HumanMessage(content=memory_block))
    if subagent_block:
        text_fallback_msgs.append(HumanMessage(content=subagent_block))
    if subagent_result_block:
        text_fallback_msgs.append(HumanMessage(content=subagent_result_block))
    if scheduled_task_block:
        text_fallback_msgs.append(HumanMessage(content=scheduled_task_block))
    text_fallback_msgs.append(HumanMessage(content=messages_content_text))

    prompt_preview = trunc(
        (
            group_text
            + "\n"
            + context_injection
            + "\nolder messages:\n"
            + hist_text
            + "\n\ncurrent messages(burst):\n"
            + current_line
            + f"\n[visual_attachments={len(media_parts)}]"
        ),
        800,
    )
    return BuiltLlm2Prompt(
        messages=msgs,
        text_fallback_messages=text_fallback_msgs,
        rendered_system=rendered_system,
        history_list=history_list,
        prompt_preview=prompt_preview,
        media_part_count=len(media_parts),
    )


def serialize_llm2_messages(messages: Iterable) -> str:
    """Render the real LLM2 message list as plain text for ``/dump``.

    Roles are labelled and multimodal image payloads are redacted (the base64
    blob is replaced with a short marker) so the dump stays readable and small
    while still reflecting that an image part was present.
    """
    sections: list[str] = []
    for msg in messages:
        role = "SYSTEM" if isinstance(msg, SystemMessage) else "USER"
        content = redact_multimodal_content(getattr(msg, "content", ""))
        if isinstance(content, list):
            rendered: list[str] = []
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    rendered.append(str(part.get("text", "")))
                elif isinstance(part, dict) and part.get("type") == "image_url":
                    url = part.get("image_url")
                    url_str = url.get("url") if isinstance(url, dict) else ""
                    rendered.append(f"[image_url: {url_str}]")
                else:
                    rendered.append(str(part))
            content_str = "\n".join(rendered)
        else:
            content_str = str(content)
        sections.append(f"=== {role} ===\n{content_str}")
    return "\n\n".join(sections)


async def generate_reply(
    history: Iterable[WhatsAppMessage],
    current: WhatsAppMessage,
    *,
    system: str | None = None,
    tools: Optional[list] = None,
    current_payload: dict | None = None,
    group_description: str | None = None,
    prompt_override: str | None = None,
    chat_type: str | None = None,
    bot_is_admin: bool = False,
    bot_is_super_admin: bool = False,
    result_validator=None,
    allow_subagent: bool = False,
    subagent_context: str | None = None,
    subagent_result_block: str | None = None,
    scheduled_task_block: str | None = None,
    memory_block: str | None = None,
):
    targets = _llm2_targets()
    payload = current_payload if isinstance(current_payload, dict) else {}
    log_chat_id = payload.get("chatId") or payload.get("chat_id") or current.sender
    chat_model_id = get_llm2_model_for_chat(log_chat_id) if log_chat_id else None
    payload_chat_type = _normalize_chat_type(
        chat_type
        or payload.get("chatType")
        or payload.get("chat_type")
        or ("group" if bool(payload.get("isGroup")) else "private")
    )
    log_chat_name = (payload.get("chatName") or payload.get("chat_name")) if payload_chat_type == "group" else None
    timeout_s = _llm2_timeout()
    retry_max = _llm2_retry_max()
    retry_backoff_s = _llm2_retry_backoff_seconds()
    sdk_max_retries = _llm2_sdk_max_retries()
    # Permissions gate both the dynamic tool list (here) and the system-prompt
    # rule injection (inside build_llm2_messages); the shared helper keeps the
    # two from drifting apart.
    can_delete, can_mute, can_kick = _compute_llm2_permissions(log_chat_id, bot_is_admin, bot_is_super_admin)

    # Build tools dynamically: base tools always, moderation tools only when permitted
    if tools is None:
        tools = build_llm2_tools(
            allow_delete=can_delete,
            allow_mute=can_mute,
            allow_kick=can_kick,
            allow_subagent=allow_subagent,
        )

    # Build the EXACT messages sent to the model via the shared builder, so
    # ``/dump`` (which serialises the same builder output) can never drift from
    # what LLM2 really sees.
    built = build_llm2_messages(
        history,
        current,
        system=system,
        prompt_override=prompt_override,
        current_payload=current_payload,
        group_description=group_description,
        chat_type=chat_type,
        bot_is_admin=bot_is_admin,
        bot_is_super_admin=bot_is_super_admin,
        allow_subagent=allow_subagent,
        subagent_context=subagent_context,
        subagent_result_block=subagent_result_block,
        scheduled_task_block=scheduled_task_block,
        memory_block=memory_block,
    )
    msgs = built.messages
    rendered_system = built.rendered_system
    history_list = built.history_list
    prompt_preview = built.prompt_preview
    media_part_count = built.media_part_count

    if env_flag("BRIDGE_LOG_PROMPT_FULL"):
        first_target = targets[0]
        logged_messages = [
            {
                "role": "system" if isinstance(m, SystemMessage) else "user",
                "content": redact_multimodal_content(getattr(m, "content", "")),
            }
            for m in msgs
        ]
        logger.info(
            "LLM2 prompt full",
            extra={
                "chat_id": log_chat_id,
                "chat_name": log_chat_name,
                "provider": first_target.name,
                "model": first_target.model,
                "endpoint": first_target.base_url,
                "messages": logged_messages,
            },
        )

    total_targets = len(targets)
    for idx, target in enumerate(targets):
        has_next_target = idx < (total_targets - 1)
        resolved_model = chat_model_id if chat_model_id else target.model
        llm = get_llm2(
            model=resolved_model,
            base_url=target.base_url,
            api_key=target.api_key,
        )
        if tools:
            try:
                # Use "auto" instead of "required" — some providers (e.g. Moonshot/Kimi
                # with thinking enabled) reject tool_choice="required" with a 400 error.
                llm = llm.bind_tools(tools, tool_choice="auto")
            except Exception:
                llm = llm.bind_tools(tools)

        logger.debug(
            "LLM2 invoke",
            extra={
                "chat_id": log_chat_id,
                "chat_name": log_chat_name,
                "provider": target.name,
                "history_len": len(history_list),
                "system_chars": len(rendered_system),
                "prompt_preview": prompt_preview,
                "model": resolved_model,
                "chat_model": chat_model_id,
                "endpoint": target.base_url,
                "timeout_s": timeout_s,
                "retry_max": retry_max,
                "retry_backoff_s": retry_backoff_s,
                "sdk_max_retries": sdk_max_retries,
            },
        )

        async def _invoke_with_retry(prompt_msgs, *, mode: str):
            attempts_total = retry_max + 1
            last_failure_kind: str | None = None
            for attempt in range(1, attempts_total + 1):
                started = time.perf_counter()
                logger.info(
                    "LLM2 invoke start (provider=%s, mode=%s, attempt=%s/%s, model=%s)",
                    target.name,
                    mode,
                    attempt,
                    attempts_total,
                    resolved_model,
                    extra={
                        "chat_id": log_chat_id,
                        "chat_name": log_chat_name,
                        "provider": target.name,
                        "model": resolved_model,
                        "endpoint": target.base_url,
                        "mode": mode,
                        "attempt": attempt,
                        "attempts_total": attempts_total,
                        "timeout_s": timeout_s,
                        "sdk_max_retries": sdk_max_retries,
                    },
                )
                try:
                    response = await llm.ainvoke(prompt_msgs)
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    logger.info(
                        "LLM2 invoke success (provider=%s, mode=%s, attempt=%s/%s, elapsed=%sms)",
                        target.name,
                        mode,
                        attempt,
                        attempts_total,
                        elapsed_ms,
                        extra={
                            "chat_id": log_chat_id,
                            "chat_name": log_chat_name,
                            "provider": target.name,
                            "model": resolved_model,
                            "endpoint": target.base_url,
                            "mode": mode,
                            "attempt": attempt,
                            "attempts_total": attempts_total,
                            "elapsed_ms": elapsed_ms,
                            "timeout_s": timeout_s,
                            "sdk_max_retries": sdk_max_retries,
                        },
                    )
                    return response, None
                except Exception as err:
                    elapsed_ms = int((time.perf_counter() - started) * 1000)
                    timeout_error = _is_timeout_error(err)
                    last_failure_kind = "timeout" if timeout_error else "error"
                    can_retry = timeout_error and attempt < attempts_total
                    logger.warning(
                        "LLM2 invoke failed",
                        exc_info=not can_retry,
                        extra={
                            "chat_id": log_chat_id,
                            "chat_name": log_chat_name,
                            "provider": target.name,
                            "model": resolved_model,
                            "endpoint": target.base_url,
                            "mode": mode,
                            "attempt": attempt,
                            "attempts_total": attempts_total,
                            "elapsed_ms": elapsed_ms,
                            "timeout_s": timeout_s,
                            "retry_backoff_s": retry_backoff_s,
                            "will_retry": can_retry,
                            "error_type": type(err).__name__,
                            "error_chain": _error_chain(err),
                            "sdk_max_retries": sdk_max_retries,
                        },
                    )
                    if not can_retry:
                        return None, last_failure_kind
                    await asyncio.sleep(retry_backoff_s * attempt)
            return None, last_failure_kind

        result, failure_kind = await _invoke_with_retry(msgs, mode="multimodal" if media_part_count else "text")
        if result is None and media_part_count:
            if failure_kind == "timeout":
                logger.warning(
                    "LLM2 multimodal timeout; skipping text-only fallback on this provider",
                    extra={
                        "chat_id": log_chat_id,
                        "chat_name": log_chat_name,
                        "provider": target.name,
                        "model": resolved_model,
                        "endpoint": target.base_url,
                        "media_parts": media_part_count,
                        "timeout_s": timeout_s,
                        "retry_max": retry_max,
                        "sdk_max_retries": sdk_max_retries,
                        "will_try_fallback_target": has_next_target,
                    },
                )
            else:
                logger.warning(
                    "LLM2 multimodal failed; retrying text-only prompt",
                    extra={
                        "chat_id": log_chat_id,
                        "chat_name": log_chat_name,
                        "provider": target.name,
                        "model": resolved_model,
                        "endpoint": target.base_url,
                        "media_parts": media_part_count,
                    },
                )
                result, _ = await _invoke_with_retry(built.text_fallback_messages, mode="text_fallback")

        if result is not None:
            logger.debug(
                "LLM2 result",
                extra={
                    "chat_id": log_chat_id,
                    "chat_name": log_chat_name,
                    "provider": target.name,
                    "model": resolved_model,
                    "endpoint": target.base_url,
                    "reply_preview": trunc(getattr(result, "content", ""), 800),
                    "tool_calls": len(getattr(result, "tool_calls", None) or []),
                    "raw": dump_json(getattr(result, "model_dump", lambda: str(result))()),
                },
            )
            # If a validator is provided, check whether the output is usable.
            # An invalid result is treated like a provider failure so the next
            # target gets a chance.
            if result_validator is not None and not result_validator(result):
                logger.warning(
                    "LLM2 result failed validation; treating as unusable",
                    extra={
                        "chat_id": log_chat_id,
                        "chat_name": log_chat_name,
                        "provider": target.name,
                        "model": resolved_model,
                        "endpoint": target.base_url,
                        "will_try_fallback_target": has_next_target,
                    },
                )
                if has_next_target:
                    continue
                # No more targets – return the result anyway so the caller can
                # log / handle the broken output as it sees fit.
                return result
            return result

        if has_next_target:
            logger.warning(
                "LLM2 provider failed; trying fallback target",
                extra={
                    "chat_id": log_chat_id,
                    "chat_name": log_chat_name,
                    "provider": target.name,
                    "model": resolved_model,
                    "endpoint": target.base_url,
                    "next_provider": targets[idx + 1].name,
                    "next_model": targets[idx + 1].model,
                    "next_endpoint": targets[idx + 1].base_url,
                },
            )

    return None
