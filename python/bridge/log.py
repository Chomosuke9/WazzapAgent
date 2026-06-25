"""Structured logging setup for the bridge + bundled WaSocket SDK.

Renders every record as a single clean line that mirrors the Node gateway so
both processes look consistent in a terminal:

    HH:MM:SS LVL [scope] message  key=val key2="val with space"

- ``LVL`` is a fixed-width 3-char tag (DBG/INF/WRN/ERR/CRT), colorized.
- ``[scope]`` is the active chat label (group name / chat id / ``system``) for
  bridge logs, or the originating component for SDK / third-party logs
  (``wasocket``, ``httpx`` …). It is padded to a fixed width so messages align.
- non-standard record attributes render as compact ``key=value`` pairs (only on
  DEBUG and WARNING+ by default — see ``BRIDGE_LOG_INFO_EXTRAS``).

Color is auto-enabled on a TTY and can be forced with ``LOG_COLOR`` (shared
with the Node side) / disabled with the standard ``NO_COLOR``. Noisy
third-party loggers (httpx, openai, websockets, aiohttp …) are floored at
WARNING by default so their per-request chatter does not drown the bridge.
"""
from __future__ import annotations

import contextvars
import json
import logging
import sys
from typing import Any

from dotenv import load_dotenv

try:
  from . import config
  from .config import env_flag
except ImportError:
  from bridge import config  # type: ignore
  from bridge.config import env_flag  # type: ignore


LOG_RECORD_BUILTINS = {
  "name",
  "msg",
  "args",
  "levelname",
  "levelno",
  "pathname",
  "filename",
  "module",
  "exc_info",
  "exc_text",
  "stack_info",
  "lineno",
  "funcName",
  "created",
  "msecs",
  "relativeCreated",
  "thread",
  "threadName",
  "processName",
  "process",
  "message",
  "asctime",
  "taskName",
  "chat_scope",
  "chat_label",
  "chat_id",
  "chat_name",
  "chatId",
  "chatName",
}


# ---------------------------------------------------------------------------
# ANSI color + level styling (shared visual language with the Node gateway)
# ---------------------------------------------------------------------------

RESET = "\x1b[0m"
DIM = "\x1b[2m"
GRAY = "\x1b[90m"
RED = "\x1b[31m"
BRIGHT_RED = "\x1b[91m"
GREEN = "\x1b[32m"
YELLOW = "\x1b[33m"
CYAN = "\x1b[36m"

_LEVEL_CODES = {
  logging.DEBUG: "DBG",
  logging.INFO: "INF",
  logging.WARNING: "WRN",
  logging.ERROR: "ERR",
  logging.CRITICAL: "CRT",
}
_LEVEL_COLORS = {
  logging.DEBUG: CYAN,
  logging.INFO: GREEN,
  logging.WARNING: YELLOW,
  logging.ERROR: RED,
  logging.CRITICAL: BRIGHT_RED,
}

# Third-party loggers whose INFO/DEBUG output is pure noise for this app.
_THIRD_PARTY_NOISY = (
  "httpx",
  "httpcore",
  "openai",
  "urllib3",
  "requests",
  "websockets",
  "aiohttp",
  "aiohttp.access",
  "asyncio",
)





def _resolve_color() -> bool:
  """Decide whether to emit ANSI color: explicit LOG_COLOR wins, then the
  standard NO_COLOR, then TTY auto-detection. Mirrors the Node gateway."""
  raw = (config.bridge_log_color() or "").strip().lower()
  if raw in {"1", "true", "always", "yes", "on"}:
    return True
  if raw in {"0", "false", "never", "no", "off"}:
    return False
  import os

  no_color = os.environ.get("NO_COLOR")
  if no_color is not None and no_color != "":
    return False
  try:
    return bool(sys.stdout.isatty())
  except Exception:
    return False


load_dotenv()
EXTRAS_JSON_LIMIT = config.bridge_log_extras_limit()
SHOW_INFO_EXTRAS = env_flag("BRIDGE_LOG_INFO_EXTRAS", False)
CHAT_LABEL_WIDTH = config.bridge_log_chat_label_width()
_chat_label_default_value = " ".join(str(config.bridge_log_chat_label_default_raw()).split()).strip()
CHAT_LABEL_DEFAULT = _chat_label_default_value or "system"
CHAT_LABEL_CONTEXT: contextvars.ContextVar[str | None] = contextvars.ContextVar(
  "bridge_chat_label_context",
  default=None,
)


def _normalize_chat_label(value: Any) -> str:
  if value is None:
    return ""
  return " ".join(str(value).split()).strip()


def _fit_chat_label(label: str, width: int) -> str:
  if width <= 0:
    return label
  if len(label) <= width:
    return label.ljust(width)
  if width <= 3:
    return label[:width]
  return f"{label[: width - 3]}..."


def _choose_chat_label(*, chat_id: str | None, chat_name: str | None, chat_label: str | None) -> str:
  explicit = _normalize_chat_label(chat_label)
  if explicit:
    return explicit
  name = _normalize_chat_label(chat_name)
  if name:
    return name
  chat_id_value = _normalize_chat_label(chat_id)
  if chat_id_value:
    return chat_id_value
  return CHAT_LABEL_DEFAULT


def set_chat_log_context(
  *,
  chat_id: str | None = None,
  chat_name: str | None = None,
  chat_label: str | None = None,
) -> contextvars.Token:
  label = _choose_chat_label(chat_id=chat_id, chat_name=chat_name, chat_label=chat_label)
  return CHAT_LABEL_CONTEXT.set(label)


def reset_chat_log_context(token: contextvars.Token) -> None:
  CHAT_LABEL_CONTEXT.reset(token)


def _resolve_record_chat_scope(record: logging.LogRecord) -> str:
  context_label = _normalize_chat_label(CHAT_LABEL_CONTEXT.get())
  name_label = _normalize_chat_label(
    getattr(record, "chat_name", None) or getattr(record, "chatName", None)
  )
  id_label = _normalize_chat_label(
    getattr(record, "chat_id", None) or getattr(record, "chatId", None)
  )
  explicit_label = _normalize_chat_label(getattr(record, "chat_label", None))
  chosen = explicit_label or context_label or name_label or id_label
  if not chosen:
    # Non-bridge records (the WaSocket SDK or a third-party lib) have no chat
    # context — fall back to the originating component so the scope column is
    # still informative (e.g. [wasocket], [httpx]).
    logger_name = record.name or ""
    if logger_name and logger_name != "bridge" and not logger_name.startswith("bridge."):
      chosen = logger_name.split(".")[0]
    else:
      chosen = CHAT_LABEL_DEFAULT
  return _fit_chat_label(chosen, CHAT_LABEL_WIDTH)


def _paint(text: str, code: str) -> str:
  return f"{code}{text}{RESET}" if code else text


def _stringify_value(value: Any) -> str:
  """Render one extra value as a compact, length-capped token."""
  if value is None:
    return "null"
  if isinstance(value, bool):
    return "true" if value else "false"
  if isinstance(value, (int, float)):
    return str(value)
  if isinstance(value, str):
    text = trunc(value, 300)
    if text == "" or any(ch in text for ch in (" ", '"', "=")):
      return json.dumps(text, ensure_ascii=False)
    return text
  try:
    text = json.dumps(value, ensure_ascii=False, default=str)
  except Exception:
    text = str(value)
  return trunc(text, EXTRAS_JSON_LIMIT)


def _render_extras(record: logging.LogRecord) -> str:
  extras = {k: v for k, v in record.__dict__.items() if k not in LOG_RECORD_BUILTINS}
  if not extras:
    return ""
  return "  " + " ".join(f"{k}={_stringify_value(v)}" for k, v in extras.items())


class ExtraFormatter(logging.Formatter):
  """Clean single-line formatter with optional color and compact extras."""

  def __init__(self, *, datefmt: str | None = None, color: bool = False) -> None:
    super().__init__(fmt=None, datefmt=datefmt)
    self.color = color

  def format(self, record: logging.LogRecord) -> str:
    record.chat_scope = _resolve_record_chat_scope(record)
    level_code = _LEVEL_CODES.get(record.levelno) or (record.levelname or "?")[:3].upper().ljust(3)
    time_text = self.formatTime(record, self.datefmt)
    scope_text = f"[{record.chat_scope}]"
    message = record.getMessage()

    # Keep INFO compact by default; include extras on DEBUG and WARNING+.
    # Set BRIDGE_LOG_INFO_EXTRAS=true to include extras at INFO too.
    include_extras = (
      record.levelno <= logging.DEBUG
      or record.levelno >= logging.WARNING
      or (record.levelno == logging.INFO and SHOW_INFO_EXTRAS)
    )
    tail = _render_extras(record) if include_extras else ""

    if self.color:
      time_text = _paint(time_text, DIM)
      level_code = _paint(level_code, _LEVEL_COLORS.get(record.levelno, ""))
      scope_text = _paint(scope_text, DIM)
      if tail:
        tail = _paint(tail, DIM)

    line = f"{time_text} {level_code} {scope_text} {message}{tail}"

    if record.exc_info and not record.exc_text:
      record.exc_text = self.formatException(record.exc_info)
    if record.exc_text:
      line = f"{line}\n{record.exc_text}"
    if record.stack_info:
      line = f"{line}\n{self.formatStack(record.stack_info)}"
    return line


_CONFIGURED = False


def setup_logging() -> logging.Logger:
  global _CONFIGURED
  bridge_logger = logging.getLogger("bridge")
  if _CONFIGURED:
    return bridge_logger

  load_dotenv()
  _level_str = config.bridge_log_level().upper()
  level = getattr(logging, _level_str, logging.INFO)
  handler = logging.StreamHandler(sys.stdout)
  handler.setFormatter(ExtraFormatter(datefmt="%H:%M:%S", color=_resolve_color()))

  # Loggers we own: the bridge itself and the bundled WaSocket SDK (which logs
  # under the separate 'wasocket' tree). Both render through the same handler
  # and must NOT propagate to root, so each record is emitted exactly once.
  for name in ("bridge", "wasocket"):
    owned = logging.getLogger(name)
    for existing in list(owned.handlers):
      owned.removeHandler(existing)
    owned.addHandler(handler)
    owned.setLevel(level)
    owned.propagate = False

  # Render any third-party WARNING+ through the same clean handler (attached to
  # root) instead of Python's ugly lastResort. When quiet (default) the root
  # floor is WARNING so library INFO/DEBUG request chatter is dropped.
  quiet = config.bridge_log_quiet_third_party()
  root = logging.getLogger()
  if handler not in root.handlers:
    root.addHandler(handler)
  root.setLevel(logging.WARNING if quiet else level)
  if quiet:
    for noisy in _THIRD_PARTY_NOISY:
      logging.getLogger(noisy).setLevel(logging.WARNING)

  _CONFIGURED = True
  return bridge_logger


def trunc(value: Any, limit: int = 400) -> str:
  """Stringify and truncate long values for debug logging."""
  text = str(value)
  if len(text) > limit:
    return text[:limit] + f"...[{len(text) - limit} more]"
  return text


def dump_json(obj: Any, limit: int = 4000) -> str:
  """Safe JSON dump with truncation for large payloads."""
  try:
    text = json.dumps(obj, ensure_ascii=False, default=str)
  except Exception:
    text = str(obj)
  return trunc(text, limit)
