# File: python/bridge/llm/prompt.py
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable, Optional

from .. import config
from ..history import WhatsAppMessage, assistant_name, format_history
from .schemas import LLM1_TOOL  # noqa: F401

# --- LLM2 system-prompt assembly (Step 09; moved verbatim from llm2.py) -------
# These constants + helpers were previously defined in ``llm/llm2.py`` and
# imported at runtime by ``session.py``. They are consolidated here so prompt
# assembly has a single home (the rendered prompt text is byte-identical).
SYSTEM_PROMPT_PATH = Path(__file__).resolve().parent.parent.parent / "systemprompt.txt"
_SYSTEM_PROMPT_CACHE: str | None = None


def _truncate_text(text: str | None, max_chars: int) -> str | None:
    if text is None or len(text) <= max_chars:
        return text
    if max_chars <= 3:
        return text[:max_chars]
    return f"{text[: max_chars - 3]}..."


def _truncate_burst_text(text: str | None, max_chars: int) -> str | None:
    if text is None:
        return None
    if not text.startswith("Burst messages ("):
        return _truncate_text(text, max_chars)
    lines = text.splitlines()
    if not lines:
        return text
    header = lines[0]
    body = lines[1:]
    truncated_body = [_truncate_text(line, max_chars) or "" for line in body]
    return "\n".join([header, *truncated_body])


def _truncate_message(msg: WhatsAppMessage, max_chars: int) -> WhatsAppMessage:
    return WhatsAppMessage(
        timestamp_ms=msg.timestamp_ms,
        sender=msg.sender,
        context_msg_id=msg.context_msg_id,
        sender_ref=msg.sender_ref,
        sender_is_admin=msg.sender_is_admin,
        sender_is_super_admin=msg.sender_is_super_admin,
        text=_truncate_burst_text(msg.text, max_chars),
        media=msg.media,
        quoted_message_id=msg.quoted_message_id,
        quoted_sender=msg.quoted_sender,
        quoted_text=_truncate_text(msg.quoted_text, max_chars),
        quoted_media=msg.quoted_media,
        quoted_sender_ref=msg.quoted_sender_ref,
        quoted_sender_is_admin=msg.quoted_sender_is_admin,
        quoted_sender_is_super_admin=msg.quoted_sender_is_super_admin,
        message_id=msg.message_id,
        role=msg.role,
    )


def _render_prompt_override(base_system: str, prompt_override: str | None) -> str:
    from datetime import datetime as _dt
    from datetime import timedelta as _td
    from datetime import timezone as _tz

    raw = config.context_time_utc_offset_raw()
    try:
        offset_hours = float(raw) if raw and raw.strip() else None
    except (TypeError, ValueError):
        offset_hours = None
    if offset_hours is not None:
        now = _dt.now(tz=_tz(_td(hours=offset_hours)))
    else:
        now = _dt.now()
    current_date = now.strftime("%A, %d %B %Y")
    rendered = base_system
    overide_text = (prompt_override or "").strip()
    rendered = rendered.replace("{{prompt_override}}", overide_text)
    rendered = rendered.replace("{{ prompt_override }}", overide_text)
    rendered = rendered.replace("{{current_date}}", current_date)
    rendered = rendered.replace("{{ current_date }}", current_date)
    return rendered


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


# Media kinds that are useful as sub-agent inputs. Stickers are intentionally
# excluded: they are emoji-like reactions, not files a user asks the bot to
# "process" or "send back", and listing them only adds noise.
_SUBAGENT_FILE_KINDS = {"image", "video", "audio", "document", "media"}


def _files_for_subagent_block(history: Iterable[WhatsAppMessage]) -> str | None:
    """Build an explicit ID->file lookup table for ``execute_subtask``.

    The model reliably knows *when* to delegate, but it tends to pass the
    contextMsgId of the latest *request / mention* message to ``context_msg_ids``
    instead of the message that actually CONTAINS the file. The resolver then
    finds no attachment for that ID and the sub-agent silently receives nothing
    (user-visible symptom: "the bot ignored the file I sent").

    Listing the exact ``[#NNNNNN] -> file`` mapping removes the inference the
    model keeps getting wrong: it can copy the right ID rather than guess. We
    read ``msg.media`` (the SENDER's own attachment) — never ``quoted_media`` —
    so a ``REPLYING TO`` line that mentions a file can never be mistaken for the
    message that holds it. Returns ``None`` when the chat has no attachable file
    so nothing is injected.
    """
    from ..history import _compact, _normalize_context_msg_id

    entries: list[str] = []
    seen: set[str] = set()
    for msg in history:
        media = (msg.media or "").strip().lower()
        if media not in _SUBAGENT_FILE_KINDS:
            continue
        cid = _normalize_context_msg_id(msg.context_msg_id, role=msg.role, media=msg.media)
        if not (cid.isdigit() and len(cid) == 6) or cid in seen:
            continue
        seen.add(cid)
        sender = assistant_name() if msg.role == "assistant" else (_compact(msg.sender) or "unknown")
        # For documents the filename / caption is carried in msg.text; surface it
        # so the model can disambiguate when several files are present.
        label = media
        caption = _compact(msg.text)
        if caption and not (caption.startswith("<media:") and caption.endswith(">")):
            label = f'{media} "{caption}"'
        entries.append(f"- [#{cid}] {label} (from {sender})")

    if not entries:
        return None
    return (
        "<files_in_chat>\n"
        "The ONLY messages in this chat that carry a file. When `execute_subtask` "
        'needs a file the user referred to ("the document earlier", "send it '
        'back"), `context_msg_ids` MUST be an ID from THIS list:\n'
        + "\n".join(entries)
        + "\nNever use the request/mention message's ID or an ID from a `REPLYING "
        "TO` line. If the file isn't listed, re-read the chat — don't invent an ID.\n"
        "For optimization purpose, we don't include sticker in here.\n"
        "</files_in_chat>"
    )


def _llm1_history_limit_for_prompt() -> int:
    """Read LLM1 history limit for embedding in system prompt text."""
    return config.llm1_history_limit()


def _llm1_message_max_chars_for_prompt() -> int:
    """Read LLM1 message max chars for embedding in system prompt text."""
    return config.llm1_message_max_chars()


def build_llm1_prompt(
    history: Iterable[WhatsAppMessage],
    current: WhatsAppMessage,
    *,
    history_limit: int,
    message_max_chars: int,
    current_media_parts: Optional[list[dict]] = None,
    current_media_notes: Optional[list[str]] = None,
    metadata_block: str | None = None,
    group_description: str | None = None,
    prompt_override: str | None = None,
    sticker_catalog: str | None = None,
):
    configured_assistant_name = assistant_name()
    history_list = list(history)[-history_limit:]
    prompt_history = [_truncate_message(msg, message_max_chars) for msg in history_list]
    current_prompt_msg = _truncate_message(current, message_max_chars)
    hist_text = format_history(prompt_history, history=prompt_history, trim_quoted=True) or "(no older messages)"
    current_line = _format_current_window(current_prompt_msg) or "(no current messages)"
    group_text = _group_description_block(group_description)
    context_messages = f"Older messages:\n{hist_text}\n\nCurrent messages (burst):\n{current_line}\n"
    current_content: str | list[dict] = context_messages
    if current_media_notes:
        current_content += "\nVisual attachments:\n" + "\n".join(f"- {note}" for note in current_media_notes)
    if current_media_parts:
        current_content = [{"type": "text", "content": current_content}]
        current_content.extend(current_media_parts)
    catalog_block = (
        f"\n\n<sticker_catalog>\nAvailable stickers:\n{sticker_catalog}\n</sticker_catalog>" if sticker_catalog else ""
    )
    base_system = f"""
You are a WhatsApp router agent ({configured_assistant_name}). Call exactly one tool — `llm_should_response`, `llm_react`, or `llm_sticker`. No other output.

**Default: SILENT.**

---

## Tools

`llm_should_response(should_response: bool, confidence: 0–100, reason: str)`
Reason: 12–60 words, specific + actionable (forwarded to LLM2). Do NOT include confidence level in the reason — it is already a separate field.

`llm_react(emoji: str, context_msg_id: str, confidence: int, reason: str)`
emoji = a single emoji to react with. Reason: Do NOT include confidence level — it is already a separate field.

`llm_sticker(sticker_name: str, context_msg_id: str, confidence: int, reason: str)`
sticker_name = exact sticker name from the sticker catalog below. Reason: Do NOT include confidence level — it is already a separate field.
{catalog_block}

---

## Response tiers — evaluate top-down, stop at first match

**MUST RESPOND** (90–95):
- Bot is @mentioned, OR message directly replies to the bot
- It's already 200 messages since bot last message

**SHOULD RESPOND** (65–80) — only if no human has adequately answered:
- Clear unanswered question within bot's domain
- Explicit open help request
- current message is a direct follow-up to the bot specifically

**MAY RESPOND** (40–60):
- current message is a direct follow-up to the bot specifically

**EXPRESS ONLY** — use `llm_react` or `llm_sticker`, no text:
- Use **llm_react (emoji)** by default: acknowledgement, mild emotion, confirming a human's correct answer. DO NOT overdo it. 1 reaction every 10 messages max.
- Use **llm_sticker** only for big moments: major milestone, genuinely funny/absurd situation — only if a sticker name clearly fits. DO NOT overdo it

**MUST NOT RESPOND**:
- Two+ humans actively conversing (no bot involvement)
- Reply directed at a specific human (not the bot)
- Greetings/farewells/banter between humans with no reaction-worthy highlight

---

## Special rules

**Bot role:** If bot is admin/super-admin → also respond to moderation messages. If normal member → ignore moderation situations entirely.

**Burst:** Evaluate all messages in `Current messages (burst)`. Busy bursts may overflow into `Older messages` — still evaluate them.

**Sticker-only / media-without-text:** Treat as casual/non-verbal. Stay silent unless bot is mentioned, replied to, or media contains a direct question.

**New member:** Only on explicit system join event — not first appearance or "hi".

---

## Input

- `Current message metadata`: mention/reply signals, recency, window size, chat state
- `Group description`: use to judge topic relevance
- `Older messages` = background; `Current messages (burst)` = trigger window
- Message IDs: 6-digit inside `[#...]`. `[#system]`/`[#pending]` = non-actionable.
- Roles: `(admin)`, `(superadmin)` are shown next to the name. Bot's own messages use `(You)` as senderRef. Normal members have no role label.
- Stickers you previously sent appear as `[sticker] name` (e.g. `[sticker] thumbs_up`).

---

## Prompt override

Extra instructions in `<prompt_override>`:
- Empty/placeholder → ignore
- Otherwise: override wins on conflicts (minimum scope); non-conflicting rules merge
- Cannot remove or weaken the `llm_should_response` requirement

<prompt_override>
{{{{prompt_override}}}}
</prompt_override>""".strip()
    rendered_system = _render_prompt_override(base_system, prompt_override)
    return [
        {
            "role": "system",
            "content": rendered_system,
        },
        {"role": "user", "content": f"Group description:\n{group_text}"},
        {"role": "user", "content": metadata_block or _metadata_block(None)},
        {"role": "user", "content": current_content},
    ]


def _count_phrase(value, singular: str, plural: str) -> str:
    if value is None:
        return f"unknown {plural}"
    if isinstance(value, int):
        return f"{value} {singular if value == 1 else plural}"
    return f"{value} {plural}"


def _is_singular_count(value) -> bool:
    return isinstance(value, int) and value == 1


def _metadata_block(current_payload: dict | None) -> str:
    payload = current_payload if isinstance(current_payload, dict) else {}
    bot_mentioned = bool(payload.get("botMentionedInWindow", payload.get("botMentioned")))
    replied_to_bot = bool(payload.get("repliedToBotInWindow", payload.get("repliedToBot")))
    bot_name_in_text = bool(payload.get("botNameMentionedInText"))
    since_assistant = payload.get("messagesSinceAssistantReply")
    assistant_replies_by_window = payload.get("assistantRepliesByWindow")
    human_window = payload.get("humanMessagesInWindow")
    explicit_join_events = payload.get("explicitJoinEventsInWindow")
    explicit_join_participants = payload.get("explicitJoinParticipantsInWindow")
    raw_chat_type = str(payload.get("chatType") or "").strip().lower()
    if raw_chat_type not in {"private", "group"}:
        raw_chat_type = "group" if bool(payload.get("isGroup")) else "private"
    if raw_chat_type == "group":
        scope_line = "This is a group chat. You're in a chat with multiple people at once."
    else:
        scope_line = "This is a private chat. You're directly chatting with one other person."
    if bool(payload.get("botIsSuperAdmin")):
        role_line = "Bot is a super admin (owner)."
    elif bool(payload.get("botIsAdmin")):
        role_line = "Bot is an admin."
    else:
        role_line = "Bot is a normal member."

    if bot_mentioned:
        mention_line = "- Bot is mentioned in this current message window."
    else:
        mention_line = "- Bot is not mentioned in this current message window."

    if replied_to_bot:
        reply_line = "- A message in this current message window replies to the bot."
    else:
        reply_line = "- No message in this current message window replies to the bot."

    if bot_name_in_text and not bot_mentioned:
        name_line = "- Bot's name is mentioned in the message text (without explicit @mention). Treat this as a soft mention — the user is likely talking to or about the bot."
    elif bot_name_in_text and bot_mentioned:
        name_line = "- Bot's name appears in the message text (already counted as @mention above)."
    else:
        name_line = None

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
            assistant_reply_lines.append(f"- Assistant has sent {count_text} in the last {window} messages.")

    if not assistant_reply_lines:
        fallback_recent = payload.get("assistantRepliesInLast20")
        fallback_text = _count_phrase(fallback_recent, "reply", "replies")
        assistant_reply_lines.append(f"- Assistant has sent {fallback_text} in the last 20 messages.")

    if _is_singular_count(human_window):
        human_window_line = f"- There is {human_window_text} in this current message window."
    else:
        human_window_line = f"- There are {human_window_text} in this current message window."

    join_event_text = _count_phrase(explicit_join_events, "event", "events")
    join_participant_text = _count_phrase(explicit_join_participants, "participant", "participants")
    if isinstance(explicit_join_events, int):
        if explicit_join_events > 0:
            join_event_line = (
                "- Explicit system member-join signals in this current message window: "
                f"{join_event_text} ({join_participant_text})."
            )
        else:
            join_event_line = "- No explicit system member-join signal in this current message window."
    else:
        join_event_line = "- Explicit system member-join signal count is unknown for this current message window."

    assistant_reply_block = "\n".join(assistant_reply_lines)
    extra_signal_block = ""
    if name_line:
        extra_signal_block = f"\n{name_line}"
    return (
        "Current message metadata:\n"
        "Helper:\n"
        "- `current message window` = only `current messages(burst)` (exclude `older messages`).\n"
        f"{mention_line}\n"
        f"{reply_line}\n"
        f"- The last assistant reply was {since_assistant_text} ago.\n"
        f"{assistant_reply_block}\n"
        f"{human_window_line}\n"
        f"{join_event_line}"
        f"{extra_signal_block}\n"
        "Chat state:\n"
        f"{scope_line}\n"
        f"{role_line}"
    )


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
To unmute a currently muted user, call mute_member with duration_minutes=0. The senderRefs of everyone currently muted are listed under "Currently muted users" in the message metadata — use those exact senderRefs to unmute.
</mute>"""

_KICK_RULES = """<kick>
KICK is ALLOWED for this chat. Use the kick_members tool to remove disruptive members.
Only kick with clear justification. Cannot kick admins.
</kick>"""

# Warning blocks injected INSTEAD of the "ALLOWED" rules above when a moderation
# action is NOT available — i.e. the chat's /permission level is too low OR the
# bot isn't a group admin (see _compute_llm2_permissions). Without these the
# model gets neither the tool nor any rule, so it silently ignores moderation
# requests or hallucinates that it acted. These let it warn the user instead.
# Only injected in GROUP chats (moderation is N/A in private chats), mirroring
# the _SUBAGENT_OFF_RULES pattern.
_DELETE_OFF_RULES = """<delete>
DELETE is NOT allowed in this chat — you have no delete_messages tool and cannot remove messages. If asked to delete a message, briefly tell the user you can't because message-delete permission isn't enabled here, and do NOT pretend you deleted anything. An admin can enable it with /permission (the bot must also be a group admin).
</delete>"""

_MUTE_OFF_RULES = """<mute>
MUTE is NOT allowed in this chat — you have no mute_member tool and cannot mute or unmute anyone. If asked, briefly tell the user you can't because mute permission isn't enabled here, and do NOT pretend you muted anyone. An admin can enable it with /permission (the bot must also be a group admin).
</mute>"""

_KICK_OFF_RULES = """<kick>
KICK is NOT allowed in this chat — you have no kick_members tool and cannot remove members. If asked to kick or remove someone, briefly tell the user you can't because kick permission isn't enabled here, and do NOT pretend you removed anyone. An admin can enable it with /permission (the bot must also be a group admin).
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
- `instruction`: the sub-agent has NO chat history and NO memory of your previous instructions. Write a self-contained brief that states the full goal — assume it knows nothing about this chat.
- Text-only messages (e.g. a pasted story) are auto-converted to `.txt` for the sub-agent.
- `high_quality=true` for complex reasoning, image/code gen/editing. `high_quality=false` (default) for routine tasks.
- NEVER say "I don't know / I can't / I'm not sure" if a sub-agent could find or compute the answer. Uncertainty without attempting a sub-agent is a failure. It's your knowledge and capability extension — use it.

Choosing `context_msg_ids`: same target-ID rule as everywhere (see the target-ID WARNING) — the message that HOLDS the file, never the request that refers to it. When any file exists, the `<files_in_chat>` list gives you the exact IDs; copy from there, and reuse a file you sent earlier's ID to revise it.

Steering / correction (re-using the sub-agent's live memory):
- If a sub-agent IS currently running, you can steer it mid-task by calling `execute_subtask` again — e.g. user changes "draw a dog" to a cat: "Change the dog to a cat, keep everything else the same."
- You can ALSO attach NEW files while steering: pass their `context_msg_ids` (same rule as above — the ID that holds the file). The running sub-agent receives them mid-task. e.g. user sends a logo and says "add this logo": call `execute_subtask` with the logo's `context_msg_ids`.
- On the re-invoke AFTER the sub-agent delivered its result (your LAST chance), you can protest/correct using the same memory — e.g. "The zip you sent shows as a compressed file, not an image. Send the image directly as a PNG, not zipped."
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
    from datetime import datetime as _dt
    from datetime import timedelta as _td
    from datetime import timezone as _tz

    raw = config.context_time_utc_offset_raw()
    try:
        offset_hours = float(raw) if raw and raw.strip() else None
    except (TypeError, ValueError):
        offset_hours = None
    if offset_hours is not None:
        now = _dt.now(tz=_tz((_td(hours=offset_hours))))
    else:
        now = _dt.now()
    return now.strftime("%A, %d %B %Y")


_PLACEHOLDER_KEYS = (
    "prompt_override", "assistant_name", "current_date", "sticker_catalog",
    "delete_rules", "mute_rules", "kick_rules", "subagent_rules",
)
_PLACEHOLDER_RE = re.compile(
    r"\{\{\s*(" + "|".join(re.escape(k) for k in _PLACEHOLDER_KEYS) + r")\s*\}\}"
)


def _render_system_prompt(
    base_system: str,
    *,
    prompt_override: str | None = None,
    allow_delete: bool = False,
    allow_mute: bool = False,
    allow_kick: bool = False,
    allow_subagent: bool = False,
    sticker_catalog: str | None = None,
    chat_type: str | None = None,
) -> str:
    overide_text = (prompt_override or "").strip()
    configured_assistant_name = assistant_name()
    current_date = _current_date_str()
    catalog = (
        f"<sticker_catalog>\nAvailable stickers:\n{sticker_catalog}\n</sticker_catalog>" if sticker_catalog else ""
    )
    # Moderation blocks: the "ALLOWED" rule when the action is available, else a
    # warning block in GROUP chats (so the model tells the user it lacks the
    # permission instead of ignoring/hallucinating), else nothing in private
    # chats where moderation does not apply.
    is_group = _normalize_chat_type(chat_type) == "group"
    delete_block = _DELETE_RULES if allow_delete else (_DELETE_OFF_RULES if is_group else "")
    mute_block = _MUTE_RULES if allow_mute else (_MUTE_OFF_RULES if is_group else "")
    kick_block = _KICK_RULES if allow_kick else (_KICK_OFF_RULES if is_group else "")
    _placeholders = {
        "prompt_override": overide_text,
        "assistant_name": configured_assistant_name,
        "current_date": current_date,
        "sticker_catalog": catalog,
        "delete_rules": delete_block,
        "mute_rules": mute_block,
        "kick_rules": kick_block,
        "subagent_rules": _SUBAGENT_RULES if allow_subagent else _SUBAGENT_OFF_RULES,
    }
    return _PLACEHOLDER_RE.sub(lambda m: _placeholders[m.group(1)], base_system)


def _normalize_chat_type(chat_type: str | None) -> str:
    lowered = (chat_type or "").strip().lower()
    if lowered in {"private", "group"}:
        return lowered
    return "private"


def _active_mutes_block(chat_id: str | None) -> str:
    """Render the list of currently-muted users so LLM2 can reference them.

    A muted user's messages are deleted by the mute gate before they ever
    reach LLM2's history, so without this block the model has no senderRef to
    target when asked to unmute someone — making unmute unreliable. Returns an
    empty string when nothing is muted (or when ``chat_id`` is unknown).
    """
    if not chat_id:
        return ""
    try:
        from ..db import list_active_mutes  # local import avoids db↔llm import cycle

        mutes = list_active_mutes(chat_id)
    except Exception:
        return ""
    if not mutes:
        return ""
    lines = []
    for m in mutes:
        name = (m.get("name") or "").strip() or "unknown"
        ref = m.get("sender_ref") or "?"
        remaining = m.get("remaining_minutes")
        lines.append(f"- {name} (senderRef: {ref}, {remaining}m remaining)")
    listing = "\n".join(lines)
    return (
        "\n\nCurrently muted users (their messages are auto-deleted and hidden from you):\n"
        f"{listing}\n"
        "To unmute one of them, call mute_member with their senderRef and duration_minutes=0."
    )


# A stored mention is `@<baked name> (<senderRef>)`. The senderRef is a 6-char
# base-36 token (see Node makeSenderRef); the name part is whatever was baked at
# save time (a real name, or — when it was unknown then — the bare LID number).
_STORED_MENTION_RE = re.compile(r"@([^@()\n]+?)\s*\(([0-9a-z]{6})\)")


def render_stored_mentions(text: str | None, chat_id: str | None) -> str | None:
    """Re-resolve the display name in every ``@Name (senderRef)`` mention LIVE.

    The ``/memory`` and ``/prompt`` text persists mentions as
    ``@<name> (<senderRef>)`` where the name was baked at save time — so a person
    who hadn't spoken yet was frozen as their bare LID number. Here we swap that
    baked name for the participant's CURRENT name (looked up by senderRef in the
    roster Node keeps fresh), while keeping the senderRef — the stable anchor the
    model reuses to mention them — untouched.

    A miss (senderRef unknown, or that person has never been seen) leaves the
    token EXACTLY as stored, so nothing is ever lost. Reserved ``@all``/``@bot``/
    ``@admin`` tokens never match (their value is not a 6-char senderRef).
    """
    if not text or not chat_id or "(" not in text:
        return text
    from ..db import get_participant_name  # local import avoids db<->llm cycle

    def _swap(match: "re.Match[str]") -> str:
        sender_ref = match.group(2)
        try:
            fresh = get_participant_name(chat_id, sender_ref)
        except Exception:
            fresh = None
        return f"@{fresh} ({sender_ref})" if fresh else match.group(0)

    return _STORED_MENTION_RE.sub(_swap, text)


def build_memory_block(chat_id: str | None) -> str | None:
    """Build the long-term memory block injected into LLM2 every turn.

    Reads the effective (shared ``__global__`` + per-chat) memory list saved via
    the ``/memory`` command and renders it as a standing context block placed
    right after the helper/context injection. Returns ``None`` when the chat has
    no saved memory so nothing is injected.

    A local import of ``get_memories`` avoids a db<->llm import cycle (mirrors
    :func:`_active_mutes_block`).
    """
    if not chat_id:
        return None
    try:
        from ..db import get_memories  # local import avoids db↔llm import cycle

        memories = get_memories(chat_id)
    except Exception:
        return None
    if not memories:
        return None
    listing = "\n".join(f"- {render_stored_mentions(m, chat_id)}" for m in memories)
    return (
        "<long_term_memory>\n"
        "Durable facts and preferences you have saved for this chat via the "
        "/memory command. Treat them as long-term context that persists across "
        "conversations. When an entry tags someone with the `@Name (senderRef)` "
        "format, reuse that exact token to mention them.\n"
        f"{listing}\n"
        "</long_term_memory>"
    )


def _chat_state_header(chat_type: str, bot_is_admin: bool, bot_is_super_admin: bool) -> str:
    normalized_type = _normalize_chat_type(chat_type)
    if normalized_type == "group":
        scope_line = "This is a group chat. You're in a chat with multiple people at once."
    else:
        scope_line = "This is a private chat. You're directly chatting with one other person."
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
    bot_mentioned = bool(payload.get("botMentionedInWindow", payload.get("botMentioned")))
    replied_to_bot = bool(payload.get("repliedToBotInWindow", payload.get("repliedToBot")))
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
            mention_line = "- You have not been mentioned in the current message window."
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
            quoted_has_media = any(token in quoted_type for token in ("sticker", "image", "video", "audio", "document"))
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
            assistant_reply_lines.append(f"- You have sent {count_text} in the last {window} messages.")

    if not assistant_reply_lines:
        fallback_recent = payload.get("assistantRepliesInLast20")
        fallback_text = _count_phrase(fallback_recent, "reply", "replies")
        assistant_reply_lines.append(f"- You have sent {fallback_text} in the last 20 messages.")

    if _is_singular_count(human_window):
        human_window_line = f"- There is {human_window_text} in the current message window."
    else:
        human_window_line = f"- There are {human_window_text} in the current message window."

    join_event_text = _count_phrase(explicit_join_events, "event", "events")
    join_participant_text = _count_phrase(explicit_join_participants, "participant", "participants")
    if isinstance(explicit_join_events, int):
        if explicit_join_events > 0:
            join_event_line = (
                "- Explicit system member-join signals in the current message window: "
                f"{join_event_text} ({join_participant_text})."
            )
        else:
            join_event_line = "- No explicit system member-join signal in the current message window."
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
    muted_users_block = _active_mutes_block(chat_id)

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
        f"{muted_users_block}"
    )
