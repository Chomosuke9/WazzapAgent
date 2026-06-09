"""Slash-command parser and handler for /prompt, /reset, /permission, /mode, /trigger, /dashboard.

/broadcast is handled entirely on the Node.js gateway side.
"""
from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

try:
  from .db import (
    get_prompt,
    set_prompt,
    get_permission,
    set_permission,
    permission_description,
    get_mode,
    set_mode,
    get_triggers,
    set_triggers,
    VALID_MODES,
    VALID_TRIGGERS,
  )
  from .log import setup_logging
  from .config import PROMPT_MAX_CHARS
except ImportError:
  import sys
  sys.path.append(str(Path(__file__).resolve().parent.parent))
  from bridge.db import (  # type: ignore
    get_prompt, set_prompt, get_permission, set_permission, permission_description,
    get_mode, set_mode, get_triggers, set_triggers, VALID_MODES, VALID_TRIGGERS,
  )
  from bridge.log import setup_logging  # type: ignore
  from bridge.config import PROMPT_MAX_CHARS  # type: ignore

logger = setup_logging()

# Match "/command" at start of text, optionally followed by arguments.
_CMD_RE = re.compile(
  r"^/(prompt|reset|permission|broadcast|mode|trigger|dashboard|help|join|sticker|add-sticker|addsticker|remove-sticker|removesticker|dump)\b\s*(.*)",
  re.IGNORECASE | re.DOTALL,
)


def _is_owner(sender_jid: str | None) -> bool:
  """Check if sender JID is in BOT_OWNER_JIDS."""
  if not sender_jid:
    return False
  raw = os.getenv("BOT_OWNER_JIDS", "")
  if not raw.strip():
    return False
  owner_jids: set[str] = set()
  for owner in raw.split(","):
    owner = owner.strip().lower()
    if not owner:
      continue
    owner_jids.add(owner)
    if "@" not in owner:
      owner_jids.add(f"{owner}@s.whatsapp.net")
      owner_jids.add(f"{owner}@lid")
  sender = sender_jid.strip().lower()
  sender_local = sender.split("@", 1)[0]
  candidates = {sender, sender_local}
  return bool(candidates & owner_jids)


@dataclass
class CommandResult:
  """Outcome of a slash-command execution."""
  command: str
  success: bool
  reply: str  # confirmation text to send back
  skip_llm: bool = True  # whether to skip LLM1/LLM2 processing


def parse_command(text: str | None) -> tuple[str | None, str | None]:
  """Return ``(command_name, args_text)`` or ``(None, None)``."""
  if not text:
    return None, None
  m = _CMD_RE.match(text.strip())
  if not m:
    return None, None
  raw = m.group(1).lower()
  # Normalise aliases so callers always see canonical names
  if raw == "addsticker":
    raw = "add-sticker"
  elif raw == "removesticker":
    raw = "remove-sticker"
  return raw, (m.group(2) or "").strip()


def handle_command(
  command: str,
  args: str,
  *,
  chat_id: str,
  chat_type: str,
  sender_is_admin: bool,
  sender_jid: str | None = None,
  bot_is_admin: bool = False,
) -> Optional[CommandResult]:
  """
  Execute a slash command and return a ``CommandResult``.

  Returns ``None`` if the command is not handled here (e.g. /broadcast).
  """
  if command == "broadcast":
    # Handled by Node.js gateway; Python only records history.
    return None

  if command == "join":
    # Handled by Node.js gateway.
    return None

  if command == "sticker":
    # Handled in main.py (requires WebSocket access and PIL processing).
    return None

  if command == "addsticker" or command == "add-sticker":
    # Handled entirely by Node.js gateway (requires WhatsApp socket for media download).
    return None

  if command == "remove-sticker":
    # Handled entirely by Node.js gateway (requires WhatsApp socket for DB access).
    return None

  if command == "prompt":
    return _handle_prompt(args, chat_id=chat_id, chat_type=chat_type, sender_is_admin=sender_is_admin)

  if command == "reset":
    return _handle_reset(chat_id=chat_id, chat_type=chat_type, sender_is_admin=sender_is_admin)

  if command == "permission":
    return _handle_permission(args, chat_id=chat_id, chat_type=chat_type, sender_is_admin=sender_is_admin, bot_is_admin=bot_is_admin)

  if command == "mode":
    return _handle_mode(args, chat_id=chat_id, chat_type=chat_type, sender_is_admin=sender_is_admin, sender_jid=sender_jid)

  if command == "trigger":
    return _handle_trigger(args, chat_id=chat_id, chat_type=chat_type, sender_is_admin=sender_is_admin, sender_jid=sender_jid)

  if command == "dashboard":
    return _handle_dashboard(chat_id=chat_id)

  if command == "help":
    return _handle_help(chat_type=chat_type)

  if command == "dump":
    # Handled entirely in main.py (needs WebSocket + history access).
    return None

  return None


# ---------------------------------------------------------------------------
# /prompt
# ---------------------------------------------------------------------------

def _handle_prompt(
  args: str,
  *,
  chat_id: str,
  chat_type: str,
  sender_is_admin: bool,
) -> CommandResult:
  is_private = chat_type == "private"

  if not is_private and not sender_is_admin:
    return CommandResult(
      command="prompt",
      success=False,
      reply="Only group admins can use `/prompt`.",
    )

  if not args:
    # Show the per-chat prompt only (not the global fallback), so the user can
    # tell whether a custom prompt is set or the chat is using the default.
    current = get_prompt(chat_id, fallback_to_global=False)
    if current:
      return CommandResult(
        command="prompt",
        success=True,
        reply=f"Current prompt:\n{current}",
      )
    return CommandResult(
      command="prompt",
      success=True,
      reply="No custom prompt set for this chat. Use `/prompt` <text> to set one.",
    )

  # Clear prompt if "-" or "clear"
  if args.strip().lower() in {"-", "clear", "reset"}:
    set_prompt(chat_id, None)
    return CommandResult(
      command="prompt",
      success=True,
      reply="Custom prompt cleared. Bot will use the default.",
    )

  if len(args) > PROMPT_MAX_CHARS:
    return CommandResult(
      command="prompt",
      success=False,
      reply=f"Prompt too long ({len(args)} chars). Maximum is {PROMPT_MAX_CHARS} characters.",
    )

  set_prompt(chat_id, args)
  preview = args[:200] + ("..." if len(args) > 200 else "")
  return CommandResult(
    command="prompt",
    success=True,
    reply=f"Prompt updated:\n{preview}",
  )


# ---------------------------------------------------------------------------
# /reset
# ---------------------------------------------------------------------------

def _handle_reset(
  *,
  chat_id: str,
  chat_type: str,
  sender_is_admin: bool,
) -> CommandResult:
  is_private = chat_type == "private"

  if not is_private and not sender_is_admin:
    return CommandResult(
      command="reset",
      success=False,
      reply="Only group admins can use `/reset`.",
    )

  # Memory clearing is done by the caller (main.py) based on this result.
  return CommandResult(
    command="reset",
    success=True,
    reply="Bot memory for this chat has been reset.",
  )


# ---------------------------------------------------------------------------
# /permission
# ---------------------------------------------------------------------------

_PERMISSION_LABELS = {
  0: "0 (all moderation forbidden)",
  1: "1 (delete allowed)",
  2: "2 (delete & mute allowed)",
  3: "3 (delete, mute & kick allowed)",
}


def _handle_permission(
  args: str,
  *,
  chat_id: str,
  chat_type: str,
  sender_is_admin: bool,
  bot_is_admin: bool = False,
) -> CommandResult:
  if chat_type == "private":
    return CommandResult(
      command="permission",
      success=False,
      reply="`/permission` can only be used in group chats.",
    )

  if not sender_is_admin:
    return CommandResult(
      command="permission",
      success=False,
      reply="Only group admins can use `/permission`.",
    )

  if not args:
    current = get_permission(chat_id)
    label = _PERMISSION_LABELS.get(current, str(current))
    return CommandResult(
      command="permission",
      success=True,
      reply=f"Current permission level: {label}",
    )

  try:
    level = int(args.strip())
  except ValueError:
    return CommandResult(
      command="permission",
      success=False,
      reply="Usage: `/permission` 0, 1, 2, or 3.",
    )

  if level < 0 or level > 3:
    return CommandResult(
      command="permission",
      success=False,
      reply="Level must be 0-3.\n0: all forbidden\n1: delete\n2: delete & mute\n3: delete, mute & kick",
    )

  if level > 0 and not bot_is_admin:
    return CommandResult(
      command="permission",
      success=False,
      reply="Bot must be an admin to enable moderation (permission 1-3). Promote the bot first, then try again.",
    )

  set_permission(chat_id, level)
  label = _PERMISSION_LABELS.get(level, str(level))
  return CommandResult(
    command="permission",
    success=True,
    reply=f"Permission updated: {label}",
  )


# ---------------------------------------------------------------------------
# /mode
# ---------------------------------------------------------------------------

def _handle_mode(
  args: str,
  *,
  chat_id: str,
  chat_type: str,
  sender_is_admin: bool = False,
  sender_jid: str | None = None,
) -> CommandResult:
  if not args:
    current = get_mode(chat_id)
    triggers = get_triggers(chat_id)
    triggers_str = ", ".join(sorted(triggers)) if triggers else "none"
    return CommandResult(
      command="mode",
      success=True,
      reply=(
        f"Current mode: *{current}*\n"
        f"Triggers (prefix/hybrid mode): {triggers_str}\n\n"
        f"_auto_ = LLM1 decides when to respond\n"
        f"_prefix_ = only responds when tagged, replied, or name mentioned\n"
        f"_hybrid_ = checks prefix triggers first, falls back to auto (LLM1). "
        f"If a prefix trigger arrives while LLM1 is running, LLM1 is cancelled and bot responds immediately"
      ),
    )

  if not _is_owner(sender_jid) and not sender_is_admin:
    return CommandResult(
      command="mode",
      success=False,
      reply="Only the bot owner or group admins can change the mode.",
    )

  mode = args.strip().lower()
  if mode not in VALID_MODES:
    return CommandResult(
      command="mode",
      success=False,
      reply=f"Invalid mode. Use: `/mode` auto, `/mode` prefix, or `/mode` hybrid",
    )

  set_mode(chat_id, mode)
  return CommandResult(
    command="mode",
    success=True,
    reply=f"Mode updated: *{mode}*",
  )


# ---------------------------------------------------------------------------
# /trigger
# ---------------------------------------------------------------------------

_TRIGGER_DESCRIPTIONS = {
  "tag": "bot @mentioned",
  "reply": "replied to bot message",
  "join": "new member joins group",
  "name": "bot name mentioned in text",
}


def _handle_trigger(
  args: str,
  *,
  chat_id: str,
  chat_type: str,
  sender_is_admin: bool = False,
  sender_jid: str | None = None,
) -> CommandResult:
  if not args:
    current = get_triggers(chat_id)
    if current:
      lines = [f"  - {t}: {_TRIGGER_DESCRIPTIONS.get(t, t)}" for t in sorted(current)]
      return CommandResult(
        command="trigger",
        success=True,
        reply="Current triggers:\n" + "\n".join(lines),
      )
    return CommandResult(
      command="trigger",
      success=True,
      reply="No triggers enabled. Bot won't respond in prefix mode.\nUse `/trigger` all to enable all triggers.",
    )

  if not _is_owner(sender_jid) and not sender_is_admin:
    return CommandResult(
      command="trigger",
      success=False,
      reply="Only the bot owner or group admins can change triggers.",
    )

  cleaned = args.strip().lower()
  if cleaned == "all":
    set_triggers(chat_id, set(VALID_TRIGGERS))
    return CommandResult(
      command="trigger",
      success=True,
      reply="All triggers enabled: " + ", ".join(sorted(VALID_TRIGGERS)),
    )

  if cleaned == "none":
    set_triggers(chat_id, set())
    return CommandResult(
      command="trigger",
      success=True,
      reply="All triggers disabled. Bot won't respond in prefix mode.",
    )

  requested = {t.strip() for t in cleaned.split(",") if t.strip()}
  invalid = requested - VALID_TRIGGERS
  if invalid:
    return CommandResult(
      command="trigger",
      success=False,
      reply=f"Invalid trigger(s): {', '.join(sorted(invalid))}\nValid: {', '.join(sorted(VALID_TRIGGERS))}",
    )

  current = get_triggers(chat_id)
  toggled_on = requested - current
  toggled_off = requested & current
  new_triggers = (current | toggled_on) - toggled_off
  set_triggers(chat_id, new_triggers)
  status_lines = []
  for t in sorted(requested):
    state = "enabled" if t in toggled_on else "disabled"
    status_lines.append(f"  - {t}: {state}")
  active_str = ", ".join(sorted(new_triggers)) if new_triggers else "none"
  return CommandResult(
    command="trigger",
    success=True,
    reply="\n".join(status_lines) + f"\nActive triggers: {active_str}",
  )


# ---------------------------------------------------------------------------
# /help
# ---------------------------------------------------------------------------

_HELP_TEXT = """\
*Daftar Perintah Bot*

\`/prompt\` [teks] — atur kepribadian/instruksi khusus bot untuk chat ini
  _Wajib admin grup. \`/prompt\` clear untuk menghapus._

\`/reset\` — hapus memori percakapan bot di chat ini
  _Wajib admin grup._

\`/permission\` [0-3] — atur izin moderasi (khusus grup)
  _Wajib admin grup._
  0 = tidak bisa kick/delete _(default)_
  1 = boleh delete pesan
  2 = boleh kick member
  3 = boleh delete & kick

\`/mode\` [auto|prefix] — atur mode respons (khusus grup)
  _Wajib owner atau admin grup._
  auto = LLM memutuskan kapan merespons
  prefix = hanya merespons jika ada trigger _(default)_

\`/trigger\` [tag|reply|name|join|all|none] — toggle trigger di mode prefix
  _Wajib owner atau admin grup._
  tag = bot di-@mention
  reply = seseorang membalas pesan bot
  name = nama bot disebut dalam teks
  join = member baru masuk grup
  all/none = aktifkan/nonaktifkan semua

\`/add-sticker\` <nama> — tambahkan sticker ke katalog bot untuk chat ini
  _Wajib admin grup. Di private chat bebas digunakan._
  Kirim/reply sticker dengan caption \`/add-sticker <nama>\`
  Contoh: \`/add-sticker senyum\`
  \`/add-sticker global <nama>\` — tambahkan ke katalog global semua chat _(owner only)_

\`/remove-sticker\` <nama> — hapus sticker dari katalog bot untuk chat ini
  _Wajib admin grup. Di private chat bebas digunakan._
  Contoh: \`/remove-sticker senyum\`
  \`/remove-sticker global <nama>\` — hapus dari katalog global _(owner only)_

\`/join\` <link> — masuk ke grup lewat link undangan

\`/dashboard\` — lihat statistik penggunaan bot

\`/help\` — tampilkan pesan ini\
"""


def _handle_help(*, chat_type: str) -> CommandResult:
  return CommandResult(
    command="help",
    success=True,
    reply=_HELP_TEXT,
  )


# ---------------------------------------------------------------------------
# /dashboard
# ---------------------------------------------------------------------------

def _handle_dashboard(*, chat_id: str) -> CommandResult:
  # Import here to avoid circular imports
  try:
    from .dashboard import get_dashboard_text
  except ImportError:
    from bridge.dashboard import get_dashboard_text  # type: ignore

  text = get_dashboard_text(chat_id)
  return CommandResult(
    command="dashboard",
    success=True,
    reply=text,
  )
