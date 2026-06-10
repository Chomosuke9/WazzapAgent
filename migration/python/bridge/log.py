from __future__ import annotations

import contextvars
import logging
import os
import sys
from typing import Any

from dotenv import load_dotenv

try:
  from .config import _parse_positive_int
except ImportError:
  from bridge.config import _parse_positive_int  # type: ignore


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


def env_flag(name: str, default: bool = False) -> bool:
  raw = os.getenv(name)
  if raw is None:
    return default
  return raw.strip().lower() in {"1", "true", "yes", "on"}


def _level_from_env() -> int:
  load_dotenv()
  level = os.getenv("BRIDGE_LOG_LEVEL", "INFO").upper()
  return getattr(logging, level, logging.INFO)


def _extras_limit_from_env() -> int:
  load_dotenv()
  return _parse_positive_int(os.getenv("BRIDGE_LOG_EXTRAS_LIMIT"), 4000)


def _chat_label_width_from_env() -> int:
  load_dotenv()
  return _parse_positive_int(os.getenv("BRIDGE_LOG_CHAT_LABEL_WIDTH"), 24)


def _chat_label_default_from_env() -> str:
  load_dotenv()
  value = " ".join(str(os.getenv("BRIDGE_LOG_CHAT_LABEL_DEFAULT", "system")).split()).strip()
  return value or "system"


EXTRAS_JSON_LIMIT = _extras_limit_from_env()
SHOW_INFO_EXTRAS = env_flag("BRIDGE_LOG_INFO_EXTRAS", False)
CHAT_LABEL_WIDTH = _chat_label_width_from_env()
CHAT_LABEL_DEFAULT = _chat_label_default_from_env()
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
  chosen = (
    explicit_label
    or context_label
    or name_label
    or id_label
    or CHAT_LABEL_DEFAULT
  )
  return _fit_chat_label(chosen, CHAT_LABEL_WIDTH)


class ExtraFormatter(logging.Formatter):
  """Formatter that appends non-standard record attributes as JSON."""

  def format(self, record: logging.LogRecord) -> str:
    record.chat_scope = _resolve_record_chat_scope(record)
    base = super().format(record)
    # Keep INFO compact by default; include extras on DEBUG and WARNING+.
    # Set BRIDGE_LOG_INFO_EXTRAS=true to include extras at INFO too.
    include_extras = (
      record.levelno <= logging.DEBUG
      or record.levelno >= logging.WARNING
      or (record.levelno == logging.INFO and SHOW_INFO_EXTRAS)
    )
    if include_extras:
      extras = {k: v for k, v in record.__dict__.items() if k not in LOG_RECORD_BUILTINS}
      if extras:
        base = f"{base} | extras={dump_json(extras, limit=EXTRAS_JSON_LIMIT)}"
    return base


def setup_logging() -> logging.Logger:
  logger = logging.getLogger("bridge")
  if logger.handlers:
    return logger
  logger.setLevel(_level_from_env())
  handler = logging.StreamHandler(sys.stdout)
  formatter = ExtraFormatter(
    fmt="%(asctime)s %(levelname)s [%(name)s] [%(chat_scope)s] %(message)s",
    datefmt="%H:%M:%S",
  )
  handler.setFormatter(formatter)
  logger.addHandler(handler)
  logger.propagate = False
  return logger


def trunc(value: Any, limit: int = 400) -> str:
  """Stringify and truncate long values for debug logging."""
  text = str(value)
  if len(text) > limit:
    return text[:limit] + f"...[{len(text) - limit} more]"
  return text


def dump_json(obj: Any, limit: int = 4000) -> str:
  """Safe JSON dump with truncation for large payloads."""
  import json  # local import to keep module light

  try:
    text = json.dumps(obj, ensure_ascii=False, default=str)
  except Exception:
    text = str(obj)
  return trunc(text, limit)
