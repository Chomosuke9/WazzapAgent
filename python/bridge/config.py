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

