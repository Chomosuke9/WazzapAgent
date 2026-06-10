from __future__ import annotations

import asyncio
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Optional

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from ..config import (
    _clean_env,
    _endpoint_base_url,
    _parse_non_negative_int,
    _parse_positive_float,
    _parse_positive_int,
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
from ..history import WhatsAppMessage, assistant_name, format_history
from ..log import dump_json, env_flag, setup_logging, trunc
from ..media import build_visual_parts, redact_multimodal_content
from ..stickers import sticker_catalog_text
from .error_utils import _error_chain, _is_timeout_error
from .prompt import _truncate_message
from .schemas import build_llm2_tools

logger = setup_logging()
SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent.parent.parent / "systemprompt.txt"
_SYSTEM_PROMPT_CACHE: str | None = None


@dataclass(frozen=True)
class LLM2Target:
    name: str
    model: str
    base_url: str | None
    api_key: str


def _llm2_message_max_chars() -> int:
    return _parse_positive_int(os.getenv("LLM2_MESSAGE_MAX_CHARS"), 0)


def _llm2_timeout() -> float:
    return _parse_positive_float(os.getenv("LLM2_TIMEOUT"), 20.0)


def _llm2_retry_max() -> int:
    return _parse_non_negative_int(os.getenv("LLM2_RETRY_MAX"), 0)


def _llm2_retry_backoff_seconds() -> float:
    return _parse_positive_float(os.getenv("LLM2_RETRY_BACKOFF_SECONDS"), 0.8)


def _llm2_sdk_max_retries() -> int:
    return _parse_non_negative_int(os.getenv("LLM2_SDK_MAX_RETRIES"), 0)


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
    primary_model = _clean_env(os.getenv("LLM2_MODEL")) or "gpt-4.1"
    primary_endpoint = _endpoint_base_url(os.getenv("LLM2_ENDPOINT"))
    primary_api_key = _clean_env(os.getenv("LLM2_API_KEY")) or ""

    targets = [
        LLM2Target(
            name="primary",
            model=primary_model,
            base_url=primary_endpoint,
            api_key=primary_api_key,
        )
    ]

    fallback_model_raw = _clean_env(os.getenv("LLM2_FALLBACK_MODEL"))
    fallback_endpoint_raw = _clean_env(os.getenv("LLM2_FALLBACK_ENDPOINT"))
    fallback_api_key_raw = _clean_env(os.getenv("LLM2_FALLBACK_API_KEY"))
    fallback_enabled = any(
        (fallback_model_raw, fallback_endpoint_raw, fallback_api_key_raw)
    )
    if not fallback_enabled:
        return targets

    fallback_endpoint = (
        _endpoint_base_url(fallback_endpoint_raw)
        if fallback_endpoint_raw is not None
        else primary_endpoint
    )
    fallback_target = LLM2Target(
        name="fallback",
        model=fallback_model_raw or primary_model,
        base_url=fallback_endpoint,
        api_key=fallback_api_key_raw
        if fallback_api_key_raw is not None
        else primary_api_key,
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


def _load_system_prompt() -> str:
    global _SYSTEM_PROMPT_CACHE
    if _SYSTEM_PROMPT_CACHE is not None:
        return _SYSTEM_PROMPT_CACHE
    text = SYSTEM_PROMPT_PATH.read_text(encoding="utf-8").strip()
    _SYSTEM_PROMPT_CACHE = text
    return _SYSTEM_PROMPT_CACHE


_DELETE_RULES = """<delete>
DELETE is ALLOWED for this chat. Use the delete_messages tool to remove rule-violating messages.
Only delete messages with clear justification.
</delete>"""

_MUTE_RULES = """<mute>
MUTE is ALLOWED for this chat. Use the mute_member tool to auto-delete all messages from a user for a specified duration.
Use for persistent rule violators. Muted user's messages are auto-deleted for the specified duration.
To unmute a currently muted user, call mute_member with duration_minutes=0.
</mute>"""

_KICK_RULES = """<kick>
KICK is ALLOWED for this chat. Use the kick_members tool to remove disruptive members.
Only kick with clear justification. Cannot kick admins.
</kick>"""

# Injected into the system prompt only when /subagent on is set for this chat
# (i.e. allow_subagent=True). Tells LLM2 when to delegate via the
# execute_subtask tool and what the sub-agent can / cannot do, so the model
# does not silently forget the tool exists or use it for trivial replies.
# Mirrors the structure of _DELETE_RULES / _MUTE_RULES / _KICK_RULES.
_SUBAGENT_RULES = """<subagent>
SUB-AGENT is ALLOWED. Use `execute_subtask` for tasks needing a real compute environment: file processing, code execution, file analysis, web scraping, producing attachments, or anything you can't answer from knowledge alone. Assume full internet + system access — it can do almost anything.
IT'S THE ONLY WAY TO ACTUALLY DO WHAT AGENTS ARE MEANT TO DO. DO NOT HALLUCINATE AND SAY YOU ALREADY DID SOMETHING WITHOUT USING THIS.
You can't access the internet, manipulate files, or perform any actions that require system-level access. But the sub-agent can do anything you tell it to do. Use it for anything you need to do.
Do not say "Sorry, as an AI assistant, I can't do that." or any similar phrases, unless the sub-agent cannot handle the task.

Do NOT use for: conversational replies, greetings, opinions, knowledge-only answers, moderation, or tasks covered by built-in commands.
Never use `execute_subtask` for tasks built-in commands can handle (stickers, status, help, etc.). Sub-agent is sandboxed — no WhatsApp access.

Rules:
- Call `execute_subtask` immediately when applicable. Acknowledgement goes in `confirmation_text`, NOT as a separate `reply_message`.
- Sub-agent has NO chat history. Write `instruction` as a self-contained brief. Pass `context_msg_ids` for needed messages (media or text), or `null`.
- Text-only messages (e.g. pasted story) are auto-converted to `.txt` for the sub-agent.
- To revise a previously sent file: pass its `[#NNNNNN]` in `context_msg_ids` — bridge resolves the path automatically.
- `high_quality=true` for complex reasoning, image/code gen/editing. `high_quality=false` (default) for routine tasks.
- NEVER say "I don't know / I can't / I'm not sure" if a sub-agent could find or compute the answer. Uncertainty without attempting a sub-agent is a failure. It's your knowledge and capability extension — use it.

Additionally, you could steer the sub-agent mid task by using `execute_subtask` again.

If a sub-agent IS currently running (its memory is alive), the you can steer it mid-task by calling `execute_subtask` again — e.g. if the first instruction said "draw a dog" but the user changes their mind, just say: "Change the dog to a cat but keep everything else the same."
If this is the LAST chance (re-invoke after sub-agent delivered its result), the you can protest/correct using the same memory — e.g. "The zip you sent shows as a compressed file, not an image. Send the image directly as a PNG, not zipped."

WARNING: DETERMINE THE CORRECT TARGET ID BEFORE USING IT. MOST OF THE TIME, SUB-AGENT ACTIONS FAIL BECAUSE YOU USED THE WRONG TARGET ID AND MAKING SUB-AGENT CONFUSED.
WARNING: CREATE AN INSTRUCTION THAT DESCRIBES WHAT YOUR GOAL IS, SUB-AGENT HAS NO CHAT HISTORY. WRITE `instruction` AS A SELF-CONTAINED BRIEF. IT HAS NO CONTEXT ABOUT PREVIOUS MESSAGES OR INSTRUCTIONS.
WARNING: SUB-AGENT HAS NO CLUE ABOUT YOUR PREVIOUS INSTRUCTIONS. IF NO SUB-AGENT RUNNING, THAT MEANS SUB-AGENT'S MEMORY ALREADY DELETED. YOU NEED TO MAKE A VERY CLEAR INSTRUCTION. TREAT IT AS A COMPLETELY NEW MEMORY.
</subagent>"""
_SUBAGENT_OFF_RULES = """
Sub-agent isn't allowed.
You don't have:
    - Access to the internet, files, or any external resources.
    - Any capability beyond a regular chatbot.
    - Ability to send files, images, audio, or any media.
DO NOT hallucinate and say "I'm gonna do that" (that means you're telling the user you will start your work, but in reality you're actually just saying some bullshit and not actually doing anything).
"""


def _current_date_str() -> str:
    """Return today's date as a human-readable string, respecting CONTEXT_TIME_UTC_OFFSET_HOURS."""
    import os as _os
    from datetime import datetime as _dt
    from datetime import timedelta as _td
    from datetime import timezone as _tz

    raw = _os.getenv("CONTEXT_TIME_UTC_OFFSET_HOURS")
    try:
        offset_hours = float(raw) if raw and raw.strip() else None
    except (TypeError, ValueError):
        offset_hours = None
    if offset_hours is not None:
        now = _dt.now(tz=_tz((_td(hours=offset_hours))))
    else:
        now = _dt.now()
    return now.strftime("%A, %d %B %Y")


def _render_system_prompt(
    base_system: str,
    *,
    prompt_override: str | None = None,
    allow_delete: bool = False,
    allow_mute: bool = False,
    allow_kick: bool = False,
    allow_subagent: bool = False,
    sticker_catalog: str | None = None,
) -> str:
    overide_text = (prompt_override or "").strip()
    configured_assistant_name = assistant_name()
    current_date = _current_date_str()
    catalog = (
        f"<sticker_catalog>\nAvailable stickers:\n{sticker_catalog}\n</sticker_catalog>"
        if sticker_catalog
        else ""
    )
    return (
        base_system.replace("{{prompt_override}}", overide_text)
        .replace("{{ prompt_override }}", overide_text)
        .replace("{{assistant_name}}", configured_assistant_name)
        .replace("{{ assistant_name }}", configured_assistant_name)
        .replace("{{current_date}}", current_date)
        .replace("{{ current_date }}", current_date)
        .replace("{{sticker_catalog}}", catalog)
        .replace("{{ sticker_catalog }}", catalog)
        .replace("{{delete_rules}}", _DELETE_RULES if allow_delete else "")
        .replace("{{ delete_rules }}", _DELETE_RULES if allow_delete else "")
        .replace("{{mute_rules}}", _MUTE_RULES if allow_mute else "")
        .replace("{{ mute_rules }}", _MUTE_RULES if allow_mute else "")
        .replace("{{kick_rules}}", _KICK_RULES if allow_kick else "")
        .replace("{{ kick_rules }}", _KICK_RULES if allow_kick else "")
        .replace(
            "{{subagent_rules}}",
            _SUBAGENT_RULES if allow_subagent else _SUBAGENT_OFF_RULES,
        )
        .replace(
            "{{ subagent_rules }}",
            _SUBAGENT_RULES if allow_subagent else _SUBAGENT_OFF_RULES,
        )
    )


def _group_description_block(group_description: str | None) -> str:
    cleaned = (group_description or "").strip()
    if cleaned:
        return cleaned
    return "(none)"


def _format_current_window(msg: WhatsAppMessage) -> str:
    # Burst windows are already serialized as multi-line chat entries.
    text = (msg.text or "").strip()
    if text.startswith("Burst messages ("):
        return text
    return format_history([msg], history=[msg])


def _normalize_chat_type(chat_type: str | None) -> str:
    lowered = (chat_type or "").strip().lower()
    if lowered in {"private", "group"}:
        return lowered
    return "private"


def _chat_state_header(
    chat_type: str, bot_is_admin: bool, bot_is_super_admin: bool
) -> str:
    normalized_type = _normalize_chat_type(chat_type)
    if normalized_type == "group":
        scope_line = (
            "This is a group chat. You're in a chat with multiple people at once."
        )
    else:
        scope_line = (
            "This is a private chat. You're directly chatting with one other person."
        )
    if bot_is_super_admin:
        role_line = "You are a super admin (owner)."
    elif bot_is_admin:
        role_line = "You are an admin."
    else:
        role_line = "You are a regular member."
    return f"{scope_line}\n{role_line}"


def _context_injection_block(
    current_payload: dict | None,
    *,
    chat_type: str,
    bot_is_admin: bool,
    bot_is_super_admin: bool,
    chat_id: str | None = None,
) -> str:
    payload = current_payload if isinstance(current_payload, dict) else {}
    bot_mentioned = bool(
        payload.get("botMentionedInWindow", payload.get("botMentioned"))
    )
    replied_to_bot = bool(
        payload.get("repliedToBotInWindow", payload.get("repliedToBot"))
    )
    mention_count = payload.get("botMentionCountInWindow")
    if mention_count is None:
        mentioned = payload.get("mentionedJids")
        if isinstance(mentioned, list):
            mention_count = len(mentioned)
        elif payload.get("botMentioned") is not None:
            mention_count = 1 if bool(payload.get("botMentioned")) else 0
        else:
            mention_count = None
    since_assistant = payload.get("messagesSinceAssistantReply")
    assistant_replies_by_window = payload.get("assistantRepliesByWindow")
    human_window = payload.get("humanMessagesInWindow")
    explicit_join_events = payload.get("explicitJoinEventsInWindow")
    explicit_join_participants = payload.get("explicitJoinParticipantsInWindow")
    quoted_has_media = payload.get("quotedHasMedia")
    llm1_reason_raw = payload.get("llm1Reason")

    def _count_phrase(value, singular: str, plural: str) -> str:
        if value is None:
            return f"unknown {plural}"
        if isinstance(value, int):
            return f"{value} {singular if value == 1 else plural}"
        return f"{value} {plural}"

    def _is_singular_count(value) -> bool:
        return isinstance(value, int) and value == 1

    try:
        mention_count = int(mention_count)
    except (TypeError, ValueError):
        pass

    mention_count_text = _count_phrase(mention_count, "time", "times")
    if isinstance(mention_count, int):
        if mention_count > 0:
            mention_line = f"- You have been mentioned {mention_count_text} in the current message window."
        elif bot_mentioned:
            mention_line = "- You have been mentioned in the current message window."
        else:
            mention_line = (
                "- You have not been mentioned in the current message window."
            )
    elif bot_mentioned:
        mention_line = "- You have been mentioned in the current message window."
    else:
        mention_line = "- You have not been mentioned in the current message window."

    if replied_to_bot:
        reply_line = "- A message in the current message window replies to you."
    else:
        reply_line = "- No message in the current message window replies to you."

    if quoted_has_media is None:
        quoted_payload = payload.get("quoted")
        if isinstance(quoted_payload, dict):
            quoted_type = str(quoted_payload.get("type") or "").strip().lower()
            quoted_has_media = any(
                token in quoted_type
                for token in ("sticker", "image", "video", "audio", "document")
            )
        else:
            quoted_has_media = False
    else:
        quoted_has_media = bool(quoted_has_media)

    if quoted_has_media:
        quoted_media_line = "- The quoted message includes media."
    else:
        quoted_media_line = "- The quoted message does not include media."

    since_assistant_text = _count_phrase(since_assistant, "message", "messages")
    human_window_text = _count_phrase(human_window, "human message", "human messages")

    assistant_reply_lines: list[str] = []
    if isinstance(assistant_replies_by_window, dict):
        assistant_reply_values: list[tuple[int, int | str]] = []
        for raw_window, raw_count in assistant_replies_by_window.items():
            try:
                window = int(raw_window)
            except (TypeError, ValueError):
                continue
            assistant_reply_values.append((window, raw_count))
        assistant_reply_values.sort(key=lambda item: item[0])
        for window, count in assistant_reply_values:
            count_text = _count_phrase(count, "reply", "replies")
            assistant_reply_lines.append(
                f"- You have sent {count_text} in the last {window} messages."
            )

    if not assistant_reply_lines:
        fallback_recent = payload.get("assistantRepliesInLast20")
        fallback_text = _count_phrase(fallback_recent, "reply", "replies")
        assistant_reply_lines.append(
            f"- You have sent {fallback_text} in the last 20 messages."
        )

    if _is_singular_count(human_window):
        human_window_line = (
            f"- There is {human_window_text} in the current message window."
        )
    else:
        human_window_line = (
            f"- There are {human_window_text} in the current message window."
        )

    join_event_text = _count_phrase(explicit_join_events, "event", "events")
    join_participant_text = _count_phrase(
        explicit_join_participants, "participant", "participants"
    )
    if isinstance(explicit_join_events, int):
        if explicit_join_events > 0:
            join_event_line = (
                "- Explicit system member-join signals in the current message window: "
                f"{join_event_text} ({join_participant_text})."
            )
        else:
            join_event_line = (
                "- No explicit system member-join signal in the current message window."
            )
    else:
        join_event_line = "- Explicit system member-join signal count is unknown for the current message window."

    llm1_reason = ""
    if isinstance(llm1_reason_raw, str):
        llm1_reason = " ".join(llm1_reason_raw.split())
    elif llm1_reason_raw is not None:
        llm1_reason = " ".join(str(llm1_reason_raw).split())
    if llm1_reason:
        llm1_reason_line = f"\nInvoke reason: {llm1_reason}\n\n"
    else:
        llm1_reason_line = "\n"

    assistant_reply_block = "\n".join(assistant_reply_lines)
    chat_state_text = _chat_state_header(chat_type, bot_is_admin, bot_is_super_admin)

    return (
        "Current message metadata:\n"
        "Helper:\n"
        "- `current message window` = only `current messages(burst)` (excludes `older messages`).\n"
        f"{mention_line}\n"
        f"{reply_line}\n"
        f"{quoted_media_line}\n"
        f"- Your last reply was {since_assistant_text} ago.\n"
        f"{assistant_reply_block}\n"
        f"{human_window_line}\n"
        f"{join_event_line}\n"
        f"{llm1_reason_line}"
        "Chat state:\n"
        f"{chat_state_text}"
    )


def get_llm2(
    *,
    model: str | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
) -> ChatOpenAI:
    resolved_model = model or (_clean_env(os.getenv("LLM2_MODEL")) or "gpt-4.1")
    temperature = float(os.getenv("LLM2_TEMPERATURE", "0.5"))
    timeout = _llm2_timeout()
    max_retries = _llm2_sdk_max_retries()
    resolved_base_url = (
        base_url
        if base_url is not None
        else _endpoint_base_url(os.getenv("LLM2_ENDPOINT"))
    )
    resolved_api_key = (
        api_key
        if api_key is not None
        else (_clean_env(os.getenv("LLM2_API_KEY")) or "")
    )
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
    log_chat_name = (
        (payload.get("chatName") or payload.get("chat_name"))
        if payload_chat_type == "group"
        else None
    )
    timeout_s = _llm2_timeout()
    retry_max = _llm2_retry_max()
    retry_backoff_s = _llm2_retry_backoff_seconds()
    sdk_max_retries = _llm2_sdk_max_retries()
    # Compute moderation permissions for dynamic tool/prompt injection
    admin_ok = bool(bot_is_admin or bot_is_super_admin)
    perm_level = db_get_permission(log_chat_id) if log_chat_id else 0
    can_delete = admin_ok and permission_allows_delete(perm_level)
    can_mute = admin_ok and permission_allows_mute(perm_level)
    can_kick = admin_ok and permission_allows_kick(perm_level)

    # Build tools dynamically: base tools always, moderation tools only when permitted
    if tools is None:
        tools = build_llm2_tools(
            allow_delete=can_delete,
            allow_mute=can_mute,
            allow_kick=can_kick,
            allow_subagent=allow_subagent,
        )

    sticker_catalog = (
        sticker_catalog_text(log_chat_id) if log_chat_id else sticker_catalog_text()
    )
    base_system = (system or _load_system_prompt()).strip()
    rendered_system = _render_system_prompt(
        base_system,
        prompt_override=prompt_override,
        allow_delete=can_delete,
        allow_mute=can_mute,
        allow_kick=can_kick,
        allow_subagent=allow_subagent,
        sticker_catalog=sticker_catalog,
    )
    history_list = list(history)
    message_max_chars = _llm2_message_max_chars()
    if message_max_chars > 0:
        history_list = [
            _truncate_message(msg, message_max_chars) for msg in history_list
        ]
        current = _truncate_message(current, message_max_chars)
    hist_text = (
        format_history(history_list, history=history_list) or "(no older messages)"
    )
    current_line = _format_current_window(current) or "(no current messages)"
    group_text = _group_description_block(group_description)
    context_injection = _context_injection_block(
        current_payload,
        chat_type=chat_type or "private",
        bot_is_admin=bot_is_admin,
        bot_is_super_admin=bot_is_super_admin,
        chat_id=log_chat_id,
    )
    messages_content_text = (
        f"older messages:\n{hist_text}\n\ncurrent messages(burst):\n{current_line}"
    )
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
        messages_content_text += "\n\nVisual attachments:\n" + "\n".join(
            f"- {note}" for note in media_notes
        )

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
    #   5) user          : sub-agent FINISHED-this-turn block (re-invoke only)
    #   6) user          : older messages + current burst
    msgs = [SystemMessage(content=rendered_system)]
    msgs.append(HumanMessage(content=f"Group description:\n{group_text}"))
    msgs.append(HumanMessage(content=context_injection))
    # Sub-agent context block: always injected as a dedicated HumanMessage
    # so LLM2 has an explicit signal about the sub-agent state (active task,
    # recently finished, or idle/ready for new tasks).
    subagent_block: str | None = subagent_context if subagent_context else None
    if subagent_block:
        msgs.append(HumanMessage(content=subagent_block))
    # ``subagent_result_block`` is a high-priority slot used by the post-task
    # re-invoke so the model gets a clear, dedicated "deliver the result now"
    # signal instead of having to dig the [SUBTASK FINISHED] line out of the
    # chat transcript. Keeping it as a separate HumanMessage (rather than
    # smuggling it into history) is what reliably stops the model from
    # repeating "oke aku cek dulu" when it should be delivering the report.
    if subagent_result_block:
        msgs.append(HumanMessage(content=subagent_result_block))
    msgs.append(HumanMessage(content=messages_content))
    if env_flag("BRIDGE_LOG_PROMPT_FULL"):
        first_target = targets[0]
        logged_messages: list[dict] = [
            {"role": "system", "content": rendered_system},
            {"role": "user", "content": f"Group description:\n{group_text}"},
            {"role": "user", "content": context_injection},
        ]
        if subagent_block:
            logged_messages.append({"role": "user", "content": subagent_block})
        if subagent_result_block:
            logged_messages.append({"role": "user", "content": subagent_result_block})
        logged_messages.append(
            {"role": "user", "content": redact_multimodal_content(messages_content)}
        )
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

        result, failure_kind = await _invoke_with_retry(
            msgs, mode="multimodal" if media_parts else "text"
        )
        if result is None and media_parts:
            if failure_kind == "timeout":
                logger.warning(
                    "LLM2 multimodal timeout; skipping text-only fallback on this provider",
                    extra={
                        "chat_id": log_chat_id,
                        "chat_name": log_chat_name,
                        "provider": target.name,
                        "model": resolved_model,
                        "endpoint": target.base_url,
                        "media_parts": len(media_parts),
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
                        "media_parts": len(media_parts),
                    },
                )
                fallback_msgs = [
                    SystemMessage(content=rendered_system),
                    HumanMessage(content=f"Group description:\n{group_text}"),
                    HumanMessage(content=context_injection),
                ]
                if subagent_block:
                    fallback_msgs.append(HumanMessage(content=subagent_block))
                if subagent_result_block:
                    fallback_msgs.append(HumanMessage(content=subagent_result_block))
                fallback_msgs.append(HumanMessage(content=messages_content_text))

                result, _ = await _invoke_with_retry(
                    fallback_msgs, mode="text_fallback"
                )

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
                    "raw": dump_json(
                        getattr(result, "model_dump", lambda: str(result))()
                    ),
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
