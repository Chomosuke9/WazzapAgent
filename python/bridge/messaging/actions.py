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
  dedup: set[str] = set()
  segments = [segment.strip() for segment in token_value.split(",")]
  for segment in segments:
    cleaned_segment = _unwrap_angle_group(segment)
    if not cleaned_segment:
      continue

    # Anchor syntax (``senderRef@...``) is legacy; the anchor is ignored.
    sender_part = cleaned_segment.split("@", 1)[0] if "@" in cleaned_segment else cleaned_segment
    sender_ref = _unwrap_angle_group(sender_part).strip().lower()
    if not SENDER_REF_RE.match(sender_ref):
      continue
    if sender_ref in dedup:
      continue
    dedup.add(sender_ref)
    parsed_targets.append({"senderRef": sender_ref})
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


_MEMORY_DELETE_RE = re.compile(
  r"^/(?:memory|memo|mem)\b"
  r"(\s+(?:global|default))?"           # optional scope prefix
  r"\s+(?:delete|del|remove|rm)\b"
  r"\s+(.+)$",                           # indices
  re.IGNORECASE,
)
_MEMORY_ADD_RE = re.compile(
  r"^/(?:memory|memo|mem)\b"
  r"(\s+(?:global|default))?"           # optional scope prefix
  r"\s+add\b"
  r"\s+(.+)$",                           # text
  re.IGNORECASE,
)


def _coalesce_memory_commands(actions: list[dict]) -> list[dict]:
  """Merge multiple ``/memory delete`` run_commands into one and ensure
  deletes execute before adds (same scope).

  Node's ``deleteMemoriesByIndices`` resolves all indices against a single
  snapshot, so ``/memory delete 2,4`` works correctly.  Without this
  coalescing the Python dispatch loop would issue separate sequential
  ``run_command`` frames, each causing a fresh snapshot → index-shift bug.
  """
  run_cmds = [a for a in actions if a.get("type") == "run_command"]
  non_run = [a for a in actions if a.get("type") != "run_command"]

  if not run_cmds:
    return actions

  # Phase 1: parse every memory-related run_command.
  # keyed by scope → {"", " global"} respectively.
  delete_by_scope: dict[str, list[tuple[int, str]]] = {}  # scope → [(index, anchor)]
  add_by_scope: dict[str, list[dict]] = {}                # scope → [action dicts]
  non_memory: list[dict] = []

  for action in run_cmds:
    cmd = action.get("command", "")
    m_del = _MEMORY_DELETE_RE.match(cmd)
    if m_del:
      scope = (m_del.group(1) or "").strip().lower()
      raw_indices = m_del.group(2) or ""
      for token in raw_indices.split(","):
        token = token.strip()
        if token.isdigit() and int(token) > 0:
          delete_by_scope.setdefault(scope, []).append(
            (int(token), action.get("contextMsgId")),
          )
      continue

    m_add = _MEMORY_ADD_RE.match(cmd)
    if m_add:
      scope = (m_add.group(1) or "").strip().lower()
      add_by_scope.setdefault(scope, []).append(action)
      continue

    non_memory.append(action)

  # If nothing was coalesced, return unchanged.
  has_deletes = any(v for v in delete_by_scope.values())
  has_adds = any(v for v in add_by_scope.values())
  if not has_deletes and not has_adds:
    return actions

  # Phase 2: rebuild the run_command list.
  result: list[dict] = []
  for scope in sorted(set(list(delete_by_scope) + list(add_by_scope))):
    # Deletes first (indices sorted ascending, deduplicated).
    entries = delete_by_scope.get(scope, [])
    if entries:
      seen_idx: set[int] = set()
      unique: list[int] = []
      anchor_first: str | None = None
      for idx, anc in entries:
        if idx in seen_idx:
          continue
        seen_idx.add(idx)
        unique.append(idx)
        if anchor_first is None:
          anchor_first = anc
      merged = "/memory"
      if scope:
        merged += " " + scope.lstrip()
      merged += " delete " + ",".join(str(i) for i in sorted(unique))
      result.append({
        "type": "run_command",
        "command": merged,
        "contextMsgId": anchor_first,
      })
    # Then adds.
    result.extend(add_by_scope.get(scope, []))

  if has_deletes:
    logger.info(
      "coalesced memory commands: %d delete indices across %d scope(s)",
      sum(len(v) for v in delete_by_scope.values()),
      len(delete_by_scope),
    )

  # Reassemble: non-run_command actions first (preserves send_message order),
  # then the reordered/coalesced run_commands.
  return non_run + result + non_memory


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

  allowed_context_ids = set(allowed_context_ids or ())
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

      # Optional `command` parameter: dispatched to the Node gateway as
      # `run_command` action(s) *after* the text reply. Commands run
      # silently — they are NOT posted as WhatsApp messages. Strict-mode
      # tool calls always populate `command` (with `null` when unused),
      # so we treat null/empty as "no command".
      #
      # The command anchor (which message it operates on, e.g. which
      # image `/sticker` should turn into a sticker) defaults to the
      # same message as the text reply (`reply_to`). The model can
      # override this via `command_context_msg_id` — either a parallel
      # array (one anchor per command) or a single value for all.
      raw_command = args.get("command")
      command_texts: list[str] = []
      if isinstance(raw_command, list):
        for c in raw_command:
          if c and isinstance(c, str):
            t = c.strip()
            if t.lower() in {"null", "none", "nil", "/"}:
              continue
            if t:
              command_texts.append(t)
      elif raw_command:
        t = str(raw_command).strip()
        if t.lower() not in {"null", "none", "nil", "/"} and t:
          command_texts.append(t)

      if command_texts:
        raw_command_ctx = args.get("command_context_msg_id")
        ctx_ids: list[str | None]
        if isinstance(raw_command_ctx, list):
          ctx_ids = list(raw_command_ctx)
        elif isinstance(raw_command_ctx, str) and raw_command_ctx.strip():
          ctx_ids = [raw_command_ctx] * len(command_texts)
        else:
          ctx_ids = [None] * len(command_texts)

        # Extend ctx_ids with None if shorter than command_texts
        while len(ctx_ids) < len(command_texts):
          ctx_ids.append(None)

        for i, command_text in enumerate(command_texts):
          if not command_text.startswith("/"):
            command_text = "/" + command_text
          anchor = ctx_ids[i]
          if anchor is None or not anchor.strip():
            resolved_anchor = reply_to
          else:
            resolved_anchor = _resolve_reply_target(
              anchor,
              fallback_reply_to=reply_to,
              allowed_context_ids=allowed_context_ids,
            )
          actions.append({
            "type": "run_command",
            "command": command_text,
            "contextMsgId": resolved_anchor,
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
      dedup: set[str] = set()
      for target in raw_targets:
        if not isinstance(target, dict):
          continue
        sender_ref = str(target.get("sender_ref") or "").strip().lower()
        if not sender_ref or not SENDER_REF_RE.match(sender_ref):
          continue
        if sender_ref in dedup:
          continue
        dedup.add(sender_ref)
        kick_targets.append({"senderRef": sender_ref})
      if kick_targets:
        actions.append({
          "type": "kick_member",
          "targets": kick_targets,
          "mode": "partial_success",
        })

    elif name == "mute_member":
      sender_ref = str(args.get("sender_ref") or "").strip().lower()
      duration = args.get("duration_minutes")
      if not sender_ref or not SENDER_REF_RE.match(sender_ref):
        logger.warning("mute ignored: invalid sender_ref %r", sender_ref)
        continue
      try:
        duration = int(duration)
      except (TypeError, ValueError):
        duration = 30
      duration = max(0, min(1440, duration))
      actions.append({
        "type": "mute_member",
        "senderRef": sender_ref,
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
      seen_ids: set[str] = set()
      invalid_ids: list[str] = []
      for raw in ctx_ids:
        cid = _normalize_context_msg_id(raw)
        if not cid or not cid.isdigit() or len(cid) != 6:
          invalid_ids.append(str(raw))
          continue
        # Unlike reply targets, an empty allowed set means there are no known
        # context messages to attach. Never let a plausible-looking six-digit
        # hallucination through to lazy media download.
        if cid not in allowed_context_ids:
          invalid_ids.append(cid)
          continue
        if cid in seen_ids:
          continue
        seen_ids.add(cid)
        valid_ids.append(cid)

      if invalid_ids:
        logger.warning(
          "execute_subtask ignored: invalid or unavailable context ids=%s",
          invalid_ids,
        )
        # Keep the confirmation coupled to the executable action: otherwise
        # the user sees "starting now" even though no task can be submitted.
        continue

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

  return _coalesce_memory_commands(actions)
