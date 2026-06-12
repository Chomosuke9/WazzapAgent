"""Shared environment-parsing utilities and bridge configuration constants."""
from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()


# ---------------------------------------------------------------------------
# Generic env-parsing helpers (used by main, llm1, llm2, log, media)
# ---------------------------------------------------------------------------

def _parse_positive_int(raw: str | None, default: int) -> int:
  if raw is None:
    return default
  try:
    parsed = int(raw)
  except (TypeError, ValueError):
    return default
  return parsed if parsed > 0 else default


def _parse_positive_float(raw: str | None, default: float) -> float:
  if raw is None:
    return default
  try:
    parsed = float(raw)
  except (TypeError, ValueError):
    return default
  return parsed if parsed > 0 else default


def _parse_non_negative_int(raw: str | None, default: int) -> int:
  if raw is None:
    return default
  try:
    parsed = int(raw)
  except (TypeError, ValueError):
    return default
  return parsed if parsed >= 0 else default


def _parse_non_negative_float(raw: str | None, default: float) -> float:
  if raw is None:
    return default
  try:
    parsed = float(raw)
  except (TypeError, ValueError):
    return default
  return parsed if parsed >= 0 else default


def _clean_env(raw: str | None) -> str | None:
  """Strip whitespace from an env value, returning ``None`` for empty strings."""
  if raw is None:
    return None
  cleaned = raw.strip()
  return cleaned or None


def _endpoint_base_url(raw_endpoint: str | None) -> str | None:
  """Normalise an LLM endpoint URL for use as ``ChatOpenAI(base_url=…)``.

  LangChain's ``ChatOpenAI`` automatically appends ``/chat/completions`` to
  ``base_url``.  Users often paste the full URL (e.g.
  ``https://openrouter.ai/api/v1/chat/completions``), so this helper strips
  that suffix when present to prevent double-appending.

  The function also:
  - strips surrounding whitespace,
  - removes trailing slashes,
  - returns ``None`` for empty / missing values.
  """
  endpoint = _clean_env(raw_endpoint)
  if not endpoint:
    return None
  trimmed = endpoint.rstrip("/")
  if trimmed.endswith("/chat/completions"):
    return trimmed[: -len("/chat/completions")]
  return trimmed


# ---------------------------------------------------------------------------
# Bridge-level configuration constants (previously in main.py)
# ---------------------------------------------------------------------------

HISTORY_LIMIT = int(os.getenv("HISTORY_LIMIT", "20"))
INCOMING_DEBOUNCE_SECONDS = _parse_positive_float(
  os.getenv("INCOMING_DEBOUNCE_SECONDS"), 5.0
)
INCOMING_BURST_MAX_SECONDS = _parse_positive_float(
  os.getenv("INCOMING_BURST_MAX_SECONDS"), 20.0
)
SLOW_BATCH_LOG_MS = _parse_non_negative_int(os.getenv("BRIDGE_SLOW_BATCH_LOG_MS"), 2000)
MAX_TRIGGER_BATCH_AGE_MS = _parse_non_negative_int(
  os.getenv("BRIDGE_MAX_TRIGGER_BATCH_AGE_MS"), 45000
)
REPLY_DEDUP_WINDOW_MS = _parse_non_negative_int(
  os.getenv("BRIDGE_REPLY_DEDUP_WINDOW_MS"), 120000
)
REPLY_DEDUP_MIN_CHARS = _parse_non_negative_int(
  os.getenv("BRIDGE_REPLY_DEDUP_MIN_CHARS"), 24
)
ASSISTANT_ECHO_MERGE_WINDOW_MS = _parse_non_negative_int(
  os.getenv("BRIDGE_ASSISTANT_ECHO_MERGE_WINDOW_MS"), 180000
)
PROMPT_MAX_CHARS = _parse_positive_int(os.getenv("PROMPT_MAX_CHARS"), 4000)
REQUIRE_ACTIVATION = os.getenv("REQUIRE_ACTIVATION", "false").lower() == "true"


# ---------------------------------------------------------------------------
# Call-time env accessors (Step 14 — centralization).
#
# These are intentionally read on each call (not frozen at import) to preserve
# the historical behaviour that several logic modules relied on — including
# tests that monkeypatch env vars such as ``ASSISTANT_NAME`` and
# ``CONTEXT_TIME_UTC_OFFSET_HOURS``. Parsing semantics and defaults are
# byte-identical to the original inline reads; only the ``os.getenv`` call now
# lives here so business/logic modules never touch the environment directly.
# ---------------------------------------------------------------------------

# -- Generic log flag (was log.env_flag) ------------------------------------

def env_flag(name: str, default: bool = False) -> bool:
  raw = os.getenv(name)
  if raw is None:
    return default
  return raw.strip().lower() in {"1", "true", "yes", "on"}


# -- Time / formatting -------------------------------------------------------

def context_time_utc_offset_raw() -> str | None:
  """Raw ``CONTEXT_TIME_UTC_OFFSET_HOURS`` value (parsing kept at call sites
  because each consumer applies subtly different defaulting)."""
  return os.getenv("CONTEXT_TIME_UTC_OFFSET_HOURS")


# -- Assistant identity ------------------------------------------------------

def assistant_name_env() -> str | None:
  """Raw ``ASSISTANT_NAME`` value (read at call-time so tenant overrides and
  test monkeypatching keep working; caching stays in history.py)."""
  return os.getenv("ASSISTANT_NAME")


# -- Accounts / transport ----------------------------------------------------

def node_url_env() -> str | None:
  return os.getenv("NODE_URL")


def accounts_json_env() -> str | None:
  return os.getenv("ACCOUNTS_JSON") or os.getenv("ACCOUNTS_CONFIG")


def folder_paths_env() -> str | None:
  return os.getenv("FOLDER_PATHS")


def folder_path_env() -> str | None:
  return os.getenv("FOLDER_PATH") or os.getenv("DATA_DIR")


def validate_node_url(url: str) -> None:
  """Validate a resolved Node WS URL (transport var, Python client side).

  Defaults exist (``ws://localhost:3000``), so a successful boot with defaults
  is unaffected; this only surfaces a clear error for a genuinely invalid /
  missing configuration.
  """
  cleaned = (url or "").strip()
  if not cleaned:
    raise ValueError("NODE_URL is required but resolved to an empty value.")
  if not (cleaned.startswith("ws://") or cleaned.startswith("wss://")):
    raise ValueError(
      f"Invalid NODE_URL {url!r}: must be a WebSocket URL starting with "
      f"'ws://' or 'wss://'."
    )


# -- LLM1 (router) -----------------------------------------------------------

def llm1_history_limit_raw() -> str | None:
  """Raw LLM1 history limit: prefer ``LLM1_HISTORY_LIMIT`` else
  ``HISTORY_LIMIT`` (int parsing kept at call sites)."""
  raw = os.getenv("LLM1_HISTORY_LIMIT")
  if raw is None or not raw.strip():
    raw = os.getenv("HISTORY_LIMIT")
  return raw


def llm1_history_limit() -> int:
  return _parse_positive_int(llm1_history_limit_raw(), 20)


def llm1_message_max_chars() -> int:
  return _parse_positive_int(os.getenv("LLM1_MESSAGE_MAX_CHARS"), 500)


def llm1_timeout(default: float = 8.0) -> float:
  return _parse_positive_float(os.getenv("LLM1_TIMEOUT"), default)


def llm1_sdk_max_retries() -> int:
  return _parse_non_negative_int(os.getenv("LLM1_SDK_MAX_RETRIES"), 0)


def llm1_temperature() -> float:
  return _parse_non_negative_float(os.getenv("LLM1_TEMPERATURE"), 0.0)


def llm1_max_tokens() -> int | None:
  raw = os.getenv("LLM1_MAX_TOKENS")
  if raw is None:
    return None
  cleaned = raw.strip()
  if not cleaned:
    return None
  try:
    parsed = int(cleaned)
  except (TypeError, ValueError):
    return None
  return parsed if parsed > 0 else None


def llm1_endpoint_base_url() -> str | None:
  return _endpoint_base_url(os.getenv("LLM1_ENDPOINT"))


def llm1_fallback_endpoint_base_url() -> str | None:
  return _endpoint_base_url(os.getenv("LLM1_FALLBACK_ENDPOINT"))


def llm1_model_clean() -> str | None:
  return _clean_env(os.getenv("LLM1_MODEL"))


def llm1_api_key() -> str:
  return os.getenv("LLM1_API_KEY") or os.getenv("OPENAI_API_KEY", "")


def llm1_fallback_model_clean() -> str | None:
  return _clean_env(os.getenv("LLM1_FALLBACK_MODEL"))


def llm1_fallback_endpoint_clean() -> str | None:
  return _clean_env(os.getenv("LLM1_FALLBACK_ENDPOINT"))


def llm1_fallback_api_key_clean() -> str | None:
  return _clean_env(os.getenv("LLM1_FALLBACK_API_KEY"))


# -- LLM2 (responder) --------------------------------------------------------

def llm2_message_max_chars() -> int:
  return _parse_positive_int(os.getenv("LLM2_MESSAGE_MAX_CHARS"), 0)


def llm2_timeout() -> float:
  return _parse_positive_float(os.getenv("LLM2_TIMEOUT"), 20.0)


def llm2_retry_max() -> int:
  return _parse_non_negative_int(os.getenv("LLM2_RETRY_MAX"), 0)


def llm2_retry_backoff_seconds() -> float:
  return _parse_positive_float(os.getenv("LLM2_RETRY_BACKOFF_SECONDS"), 0.8)


def llm2_sdk_max_retries() -> int:
  return _parse_non_negative_int(os.getenv("LLM2_SDK_MAX_RETRIES"), 0)


def llm2_model_clean() -> str | None:
  return _clean_env(os.getenv("LLM2_MODEL"))


def llm2_endpoint_base_url() -> str | None:
  return _endpoint_base_url(os.getenv("LLM2_ENDPOINT"))


def llm2_api_key_clean() -> str | None:
  return _clean_env(os.getenv("LLM2_API_KEY"))


def llm2_temperature_raw() -> str:
  return os.getenv("LLM2_TEMPERATURE", "0.5")


def llm2_fallback_model_clean() -> str | None:
  return _clean_env(os.getenv("LLM2_FALLBACK_MODEL"))


def llm2_fallback_endpoint_clean() -> str | None:
  return _clean_env(os.getenv("LLM2_FALLBACK_ENDPOINT"))


def llm2_fallback_api_key_clean() -> str | None:
  return _clean_env(os.getenv("LLM2_FALLBACK_API_KEY"))


# -- Bridge logging ----------------------------------------------------------

def bridge_log_level() -> str:
  return os.getenv("BRIDGE_LOG_LEVEL", "INFO")


def bridge_log_extras_limit() -> int:
  return _parse_positive_int(os.getenv("BRIDGE_LOG_EXTRAS_LIMIT"), 4000)


def bridge_log_chat_label_width() -> int:
  return _parse_positive_int(os.getenv("BRIDGE_LOG_CHAT_LABEL_WIDTH"), 24)


def bridge_log_chat_label_default_raw() -> str:
  return str(os.getenv("BRIDGE_LOG_CHAT_LABEL_DEFAULT", "system"))


# -- Sticker DB --------------------------------------------------------------

def db_busy_timeout_seconds() -> float:
  return float(os.getenv("DB_BUSY_TIMEOUT_SECONDS", "30"))


def db_operation_retry_max() -> int:
  return int(os.getenv("DB_OPERATION_RETRY_MAX", "8"))


def db_operation_retry_base() -> float:
  return float(os.getenv("DB_OPERATION_RETRY_BASE_SECONDS", "0.05"))


def stickers_db_path_raw() -> str | None:
  return os.getenv("BOT_STICKERS_DB_PATH") or os.getenv("STICKERS_DB_PATH")


def sticker_upload_dir_raw() -> str | None:
  return os.getenv("STICKER_UPLOAD_DIR")

