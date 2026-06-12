from __future__ import annotations

import re

from ..log import setup_logging
from ..llm.tool_utils import extract_tool_args, get_tool_call_name
from .processing import (
  _normalize_context_msg_id,
  _normalize_preview_text,
  EMPTY_TARGET_TOKENS,
  SENDER_REF_RE,
)

logger = setup_logging()

ACTION_LINE_RE = re.compile(r"^\[?\s*(REPLY_TO|DELETE|KICK|REACT_TO|STICKER)\s*[:=]\s*(.*?)\s*\]?$", re.IGNORECASE)
REACT_TOKEN_RE = re.compile(r"^(.+?)@(\d{6})$")


def _extract_reply_text(msg) -> str | None:
  if hasattr(msg, "content") and isinstance(msg.content, str):
    return msg.content.strip()
  if hasattr(msg, "content") and isinstance(msg.content, list):
    parts = [part for part in msg.content if isinstance(part, str)]
    return "\n".join(parts).strip() if parts else None
  return None


def _is_empty_target_token(value: str | None) -> bool:
  if value is None:
    return True
  return value.strip().lower() in EMPTY_TARGET_TOKENS


def _unwrap_angle_group(value: str | None) -> str:
  return "" if value is None else str(value).strip()


def _resolve_reply_target(
  token: str | None,
  *,
  fallback_reply_to: str | None,
  allowed_context_ids: set[str],
) -> str | None:
  if token is None:
    return fallback_reply_to
  token_value = _unwrap_angle_group(token)
  if not token_value:
    return None
  lowered = token_value.lower()
  if lowered in EMPTY_TARGET_TOKENS:
    return None
  normalized = _normalize_context_msg_id(token_value)
  if not normalized:
    logger.warning("reply target ignored: invalid context id token=%r", token)
    return None
  if allowed_context_ids and normalized not in allowed_context_ids:
    logger.warning("reply target ignored: context id %s not present in allowed context ids", normalized)
    return None
  return normalized


def _resolve_delete_target(
  token: str | None,
  *,
  allowed_context_ids: set[str],
) -> str | None:
  if _is_empty_target_token(token):
    return None
  normalized = _normalize_context_msg_id(token)
  if not normalized:
    return None
  if allowed_context_ids and normalized not in allowed_context_ids:
    return None
  return normalized


def _parse_delete_targets(
  token: str | None,
  *,
  allowed_context_ids: set[str],
) -> list[str]:
  token_value = _unwrap_angle_group(token)
  if not token_value:
    return []
  if _is_empty_target_token(token_value):
    return []
  parsed_targets: list[str] = []
  dedup: set[str] = set()
  parts = re.split(r"[,\s]+", token_value)
  for part in parts:
    normalized = _resolve_delete_target(part, allowed_context_ids=allowed_context_ids)
    if not normalized:
      continue
    if normalized in dedup:
      continue
    dedup.add(normalized)
    parsed_targets.append(normalized)
  return parsed_targets


def _parse_kick_targets(
  token: str | None,
  *,
  allowed_context_ids: set[str],
) -> list[dict[str, str]]:
  token_value = _unwrap_angle_group(token)
  if not token_value:
    return []
  if _is_empty_target_token(token_value):
    return []

  parsed_targets: list[dict[str, str]] = []
  dedup: set[tuple[str, str]] = set()
  segments = [segment.strip() for segment in token_value.split(",")]
  active_sender_ref: str | None = None
  for segment in segments:
    cleaned_segment = _unwrap_angle_group(segment)
    if not cleaned_segment:
      continue

    if "@" in cleaned_segment:
      sender_part, anchors_part = cleaned_segment.split("@", 1)
      sender_ref = _unwrap_angle_group(sender_part).strip().lower()
      if not SENDER_REF_RE.match(sender_ref):
        active_sender_ref = None
        continue
      active_sender_ref = sender_ref
      anchor_tokens = [anchors_part.strip()]
    else:
      if not active_sender_ref:
        continue
      sender_ref = active_sender_ref
      anchor_tokens = [cleaned_segment]

    for anchor_token in anchor_tokens:
      anchor_context_msg_id = _normalize_context_msg_id(_unwrap_angle_group(anchor_token))
      if not anchor_context_msg_id:
        continue
      if allowed_context_ids and anchor_context_msg_id not in allowed_context_ids:
        continue
      dedup_key = (sender_ref, anchor_context_msg_id)
      if dedup_key in dedup:
        continue
      dedup.add(dedup_key)
      parsed_targets.append(
        {
          "senderRef": sender_ref,
          "anchorContextMsgId": anchor_context_msg_id,
        }
      )
  return parsed_targets


def _parse_react_context_ids(
  token: str | None,
  *,
  allowed_context_ids: set[str],
) -> list[str]:
  """Parse ``REACT_TO:<NNNNNN,NNNNNN,...>`` value into a list of context message IDs."""
  token_value = _unwrap_angle_group(token)
  if not token_value:
    return []
  if _is_empty_target_token(token_value):
    return []

  result: list[str] = []
  seen: set[str] = set()
  for segment in token_value.split(","):
    cleaned = _unwrap_angle_group(segment.strip())
    if not cleaned:
      continue
    context_msg_id = _normalize_context_msg_id(cleaned)
    if not context_msg_id:
      continue
    if allowed_context_ids and context_msg_id not in allowed_context_ids:
      continue
    if context_msg_id in seen:
      continue
    seen.add(context_msg_id)
    result.append(context_msg_id)
  return result


def _extract_actions(
  msg,
  *,
  fallback_reply_to: str | None,
  allowed_context_ids: set[str],
) -> list[dict]:
  text = _extract_reply_text(msg)
  if not text:
    return []

  actions: list[dict] = []
  orphan_lines: list[str] = []
  reply_declared = False
  reply_target = fallback_reply_to
  reply_lines: list[str] = []
  react_declared = False
  react_context_ids: list[str] = []
  sticker_declared = False
  sticker_reply_to: str | None = None

  def flush_reply_block() -> None:
    nonlocal reply_declared, reply_target, reply_lines
    if not reply_declared:
      return
    body_text = "\n".join(reply_lines).strip()
    if body_text:
      # Note: sanitization is done centrally in gateway.py:send_message()
      # before the text is sent, so we don't sanitize here.
      actions.append(
        {
          "type": "send_message",
          "text": body_text,
          "replyTo": reply_target,
        }
      )
    reply_declared = False
    reply_target = fallback_reply_to
    reply_lines = []

  def flush_react_block() -> None:
    nonlocal react_declared, react_context_ids
    if not react_declared:
      return
    react_declared = False
    react_context_ids = []

  def flush_sticker_block() -> None:
    nonlocal sticker_declared, sticker_reply_to
    if not sticker_declared:
      return
    sticker_declared = False
    sticker_reply_to = None

  lines = text.splitlines()
  for raw_line in lines:
    stripped = raw_line.strip()
    marker = ACTION_LINE_RE.match(stripped)
    if not marker:
      if sticker_declared and stripped:
        # Next non-empty line after STICKER: is the sticker name
        actions.append(
          {
            "type": "send_sticker",
            "stickerName": stripped,
            "replyTo": sticker_reply_to,
          }
        )
        flush_sticker_block()
      elif react_declared and stripped:
        emoji = stripped
        for ctx_id in react_context_ids:
          actions.append(
            {
              "type": "react_message",
              "contextMsgId": ctx_id,
              "emoji": emoji,
            }
          )
        flush_react_block()
      elif reply_declared:
        reply_lines.append(raw_line)
      else:
        orphan_lines.append(raw_line)
      continue

    control = marker.group(1).upper()
    value = marker.group(2).strip()

    flush_react_block()

    if control == "REPLY_TO":
      flush_reply_block()
      reply_declared = True
      reply_target = _resolve_reply_target(
        value,
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )
      continue

    if control == "DELETE":
      for target in _parse_delete_targets(
        value,
        allowed_context_ids=allowed_context_ids,
      ):
        actions.append({"type": "delete_message", "contextMsgId": target})
      continue

    if control == "KICK":
      kick_targets = _parse_kick_targets(
        value,
        allowed_context_ids=allowed_context_ids,
      )
      if kick_targets:
        actions.append(
          {
            "type": "kick_member",
            "targets": kick_targets,
            "mode": "partial_success",
            "autoReplyAnchor": True,
          }
        )
      continue

    if control == "REACT_TO":
      flush_reply_block()
      flush_sticker_block()
      ctx_ids = _parse_react_context_ids(
        value,
        allowed_context_ids=allowed_context_ids,
      )
      if ctx_ids:
        react_declared = True
        react_context_ids = ctx_ids
      continue

    if control == "STICKER":
      flush_reply_block()
      flush_react_block()
      sticker_declared = True
      sticker_reply_to = _resolve_reply_target(
        value,
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )

  flush_reply_block()
  flush_react_block()
  flush_sticker_block()

  orphan_text = "\n".join(orphan_lines).strip()
  if orphan_text and not actions:
    # LLM2 gave a plain-text response without calling any tools
    # or using any control lines → send it as a message directly.
    # Note: sanitization is done centrally in gateway.py:send_message().
    actions.append({
      "type": "send_message",
      "text": orphan_text,
      "replyTo": fallback_reply_to,
    })
  elif orphan_text:
    logger.info(
      "dropping llm2 text outside REPLY_TO block",
      extra={
        "text_preview": _normalize_preview_text(orphan_text, limit=180),
        "fallback_reply_to": fallback_reply_to,
      },
    )

  return actions


# ---------------------------------------------------------------------------
# Tool-call-based action extraction (replaces _extract_actions for LLM2)
# ---------------------------------------------------------------------------

def _extract_actions_from_tool_calls(
  tool_calls: list,
  *,
  fallback_reply_to: str | None,
  allowed_context_ids: set[str],
) -> list[dict]:
  """Convert LLM2 tool calls into the same action dicts that the dispatch loop expects."""
  if not tool_calls:
    return []

  actions: list[dict] = []

  for tc in tool_calls:
    name = get_tool_call_name(tc)
    if not name:
      continue
    args = extract_tool_args(tc)

    if name == "reply_message":
      text = str(args.get("text") or "").strip()
      # Note: sanitization is done centrally in gateway.py:send_message().
      if not text:
        continue
      reply_to = _resolve_reply_target(
        args.get("context_msg_id"),
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )
      actions.append({
        "type": "send_message",
        "text": text,
        "replyTo": reply_to,
      })

      # Optional `command` parameter: dispatched to the Node gateway as a
      # `run_command` action *after* the text reply. The command runs
      # silently — it is NOT posted as a WhatsApp message. Strict-mode
      # tool calls always populate `command` (with `null` when unused),
      # so we treat null/empty as "no command".
      #
      # The command's anchor (which message it operates on, e.g. which
      # image `/sticker` should turn into a sticker) defaults to the
      # same message as the text reply (`reply_to`). The model can
      # override this via `command_context_msg_id` when the reply
      # target and the command target are DIFFERENT messages — e.g.
      # the bot replies to the user's instruction "make this a sticker"
      # but `/sticker` must operate on the image the user was quoting.
      raw_command = args.get("command")
      command_text = str(raw_command or "").strip() if raw_command else ""
      if command_text:
        if not command_text.startswith("/"):
          logger.warning(
            "reply_message.command ignored: must start with '/' (got %r)",
            command_text[:80],
          )
        else:
          raw_command_ctx = args.get("command_context_msg_id")
          if raw_command_ctx is None or (
            isinstance(raw_command_ctx, str) and not raw_command_ctx.strip()
          ):
            command_anchor = reply_to
          else:
            command_anchor = _resolve_reply_target(
              raw_command_ctx,
              fallback_reply_to=reply_to,
              allowed_context_ids=allowed_context_ids,
            )
          actions.append({
            "type": "run_command",
            "command": command_text,
            "contextMsgId": command_anchor,
          })

    elif name == "react_to_message":
      emoji = str(args.get("emoji") or "").strip()
      ctx_id = _normalize_context_msg_id(args.get("context_msg_id"))
      if not emoji or not ctx_id:
        continue
      if allowed_context_ids and ctx_id not in allowed_context_ids:
        logger.warning("react target ignored: context id %s not in allowed set", ctx_id)
        continue
      actions.append({
        "type": "react_message",
        "contextMsgId": ctx_id,
        "emoji": emoji,
      })

    elif name == "send_sticker":
      sticker_name = str(args.get("sticker_name") or "").strip()
      ctx_id = _normalize_context_msg_id(args.get("context_msg_id"))
      if not sticker_name or not ctx_id:
        continue
      if allowed_context_ids and ctx_id not in allowed_context_ids:
        logger.warning("sticker target ignored: context id %s not in allowed set", ctx_id)
        continue
      reply_to = _resolve_reply_target(
        args.get("context_msg_id"),
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )
      actions.append({
        "type": "send_sticker",
        "stickerName": sticker_name,
        "replyTo": reply_to,
      })

    elif name == "delete_messages":
      raw_ids = args.get("context_msg_ids") or []
      if isinstance(raw_ids, str):
        raw_ids = [raw_ids]
      seen: set[str] = set()
      for raw_id in raw_ids:
        ctx_id = _normalize_context_msg_id(raw_id)
        if not ctx_id or ctx_id in seen:
          continue
        if allowed_context_ids and ctx_id not in allowed_context_ids:
          continue
        seen.add(ctx_id)
        actions.append({"type": "delete_message", "contextMsgId": ctx_id})

    elif name == "kick_members":
      raw_targets = args.get("targets") or []
      kick_targets: list[dict[str, str]] = []
      dedup: set[tuple[str, str]] = set()
      for target in raw_targets:
        if not isinstance(target, dict):
          continue
        sender_ref = str(target.get("sender_ref") or "").strip().lower()
        anchor = _normalize_context_msg_id(target.get("anchor_context_msg_id"))
        if not sender_ref or not SENDER_REF_RE.match(sender_ref) or not anchor:
          continue
        if allowed_context_ids and anchor not in allowed_context_ids:
          continue
        key = (sender_ref, anchor)
        if key in dedup:
          continue
        dedup.add(key)
        kick_targets.append({
          "senderRef": sender_ref,
          "anchorContextMsgId": anchor,
        })
      if kick_targets:
        actions.append({
          "type": "kick_member",
          "targets": kick_targets,
          "mode": "partial_success",
          "autoReplyAnchor": True,
        })

    elif name == "mute_member":
      sender_ref = str(args.get("sender_ref") or "").strip().lower()
      anchor = _normalize_context_msg_id(args.get("anchor_context_msg_id"))
      duration = args.get("duration_minutes")
      if not sender_ref or not SENDER_REF_RE.match(sender_ref):
        logger.warning("mute ignored: invalid sender_ref %r", sender_ref)
        continue
      if not anchor:
        logger.warning("mute ignored: invalid anchor_context_msg_id")
        continue
      if allowed_context_ids and anchor not in allowed_context_ids:
        logger.warning("mute ignored: anchor %s not in allowed set", anchor)
        continue
      try:
        duration = int(duration)
      except (TypeError, ValueError):
        duration = 30
      duration = max(0, min(1440, duration))
      actions.append({
        "type": "mute_member",
        "senderRef": sender_ref,
        "anchorContextMsgId": anchor,
        "durationMinutes": duration,
      })

    elif name == "send_quiz":
      question = str(args.get("question") or "").strip()
      if not question:
        logger.warning("send_quiz ignored: missing question")
        continue
      raw_choices = args.get("choices") or []
      if not isinstance(raw_choices, list) or len(raw_choices) < 2:
        logger.warning("send_quiz ignored: need at least 2 choices")
        continue
      choices = []
      for ch in raw_choices:
        if not isinstance(ch, dict):
          continue
        label = str(ch.get("label") or "").strip()
        text = str(ch.get("text") or "").strip()
        if not label or not text:
          continue
        # Sanitize label: extract first letter only.
        # The LLM sometimes over-specifies e.g. label="B,text:" or
        # label="C,text" — keep just the leading letter.
        label = re.sub(r'[^A-Za-z]', '', label)
        if label:
          label = label[0].upper()
        if not label:
          continue
        # Strip leading separator chars from text that leaked from a
        # malformed label e.g. text=". Cari info" → "Cari info".
        text = re.sub(r'^[\s:;,.\-]+', '', text)
        if not text:
          continue
        # Enforce 20-char hard cap on text just in case LLM overshoots
        text = text[:20]
        choices.append({
          "label": label,
          "text": text,
        })
      if len(choices) < 2:
        logger.warning("send_quiz ignored: fewer than 2 valid choices after validation")
        continue
      reply_to = _resolve_reply_target(
        args.get("context_msg_id"),
        fallback_reply_to=fallback_reply_to,
        allowed_context_ids=allowed_context_ids,
      )
      footer = args.get("footer")
      footer = str(footer).strip() if footer else None
      actions.append({
        "type": "send_quiz",
        "question": question,
        "choices": choices,
        "replyTo": reply_to,
        "footer": footer,
      })

    elif name == "execute_subtask":
      instruction = str(args.get("instruction") or "").strip()
      confirmation_text = str(args.get("confirmation_text") or "").strip()
      high_quality = bool(args.get("high_quality", False))
      if not instruction:
        continue

      ctx_ids = args.get("context_msg_ids") or []
      if isinstance(ctx_ids, str):
        ctx_ids = [ctx_ids]

      # Normalize and validate context msg ids
      valid_ids: list[str] = []
      for raw in ctx_ids:
        cid = _normalize_context_msg_id(raw)
        if cid and cid.isdigit() and len(cid) == 6:
          valid_ids.append(cid)

      # If confirmation_text is provided, send it immediately.
      # If there are input files, reply to the last file; otherwise use fallback_reply_to.
      if confirmation_text:
        # Note: sanitization is done centrally in gateway.py:send_message().
        conf_reply_to = valid_ids[-1] if valid_ids else fallback_reply_to
        actions.append({
          "type": "send_message",
          "text": confirmation_text,
          "replyTo": conf_reply_to,
        })

      actions.append({
        "type": "execute_subtask",
        "instruction": instruction,
        "contextMsgIds": valid_ids,
        "high_quality": high_quality,
      })

    else:
      logger.warning("unknown LLM2 tool call: %s", name)

  return actions
