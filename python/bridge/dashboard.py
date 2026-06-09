"""Dashboard stats tracking with RAM buffer and periodic DB flush.

Counters accumulate in memory and are flushed to SQLite every ~60 seconds
to avoid high-frequency writes under heavy traffic.
"""
from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

try:
  from .db import (
    upsert_stats_batch,
    upsert_user_stats_batch,
    get_stats,
    get_top_users,
  )
  from .log import setup_logging
except ImportError:
  import sys
  sys.path.append(str(Path(__file__).resolve().parent.parent))
  from bridge.db import upsert_stats_batch, upsert_user_stats_batch, get_stats, get_top_users  # type: ignore
  from bridge.log import setup_logging  # type: ignore

logger = setup_logging()

FLUSH_INTERVAL_SECONDS = 60

# ---------------------------------------------------------------------------
# In-memory accumulators
# ---------------------------------------------------------------------------

# (chat_id, period_type, period_key, stat_key) → increment
_stats_buffer: dict[tuple[str, str, str, str], int] = {}
# (chat_id, period_type, period_key, sender_ref) → (sender_name, increment)
_user_stats_buffer: dict[tuple[str, str, str, str], tuple[str, int]] = {}
_buffer_lock = threading.Lock()


def _utc_offset_hours() -> float:
  import os
  raw = os.getenv("CONTEXT_TIME_UTC_OFFSET_HOURS")
  if raw is None:
    return 0.0
  try:
    return float("".join(raw.split()))
  except (TypeError, ValueError):
    return 0.0


def _now_local() -> datetime:
  offset = _utc_offset_hours()
  return datetime.now(tz=timezone(timedelta(hours=offset)))


def _period_keys() -> list[tuple[str, str]]:
  """Return [(period_type, period_key), ...] for current local time."""
  now = _now_local()
  return [
    ("daily", now.strftime("%Y-%m-%d")),
    ("weekly", f"{now.isocalendar()[0]}-W{now.isocalendar()[1]:02d}"),
    ("monthly", now.strftime("%Y-%m")),
  ]


def record_stat(chat_id: str, stat_key: str, increment: int = 1) -> None:
  """Thread-safe increment of a stat for all periods."""
  periods = _period_keys()
  with _buffer_lock:
    for period_type, period_key in periods:
      key = (chat_id, period_type, period_key, stat_key)
      _stats_buffer[key] = _stats_buffer.get(key, 0) + increment


def record_user_invoke(chat_id: str, sender_ref: str, sender_name: str) -> None:
  """Track which user invoked the bot."""
  periods = _period_keys()
  with _buffer_lock:
    for period_type, period_key in periods:
      key = (chat_id, period_type, period_key, sender_ref)
      existing = _user_stats_buffer.get(key)
      if existing:
        _user_stats_buffer[key] = (sender_name, existing[1] + 1)
      else:
        _user_stats_buffer[key] = (sender_name, 1)


def flush_to_db() -> None:
  """Write accumulated stats to SQLite. Called periodically and on shutdown."""
  with _buffer_lock:
    stats_snapshot = dict(_stats_buffer)
    _stats_buffer.clear()
    user_snapshot = dict(_user_stats_buffer)
    _user_stats_buffer.clear()

  if not stats_snapshot and not user_snapshot:
    return

  try:
    if stats_snapshot:
      rows = [
        (chat_id, pt, pk, sk, inc)
        for (chat_id, pt, pk, sk), inc in stats_snapshot.items()
      ]
      upsert_stats_batch(rows)

    if user_snapshot:
      rows = [
        (chat_id, pt, pk, sr, name, inc)
        for (chat_id, pt, pk, sr), (name, inc) in user_snapshot.items()
      ]
      upsert_user_stats_batch(rows)

    total = len(stats_snapshot) + len(user_snapshot)
    logger.debug("dashboard flush: %d stat rows, %d user rows", len(stats_snapshot), len(user_snapshot))
  except Exception as e:
    with _buffer_lock:
      for key, inc in stats_snapshot.items():
        _stats_buffer[key] = _stats_buffer.get(key, 0) + inc
      for key, (name, inc) in user_snapshot.items():
        existing = _user_stats_buffer.get(key)
        if existing:
          _user_stats_buffer[key] = (name or existing[0], existing[1] + inc)
        else:
          _user_stats_buffer[key] = (name, inc)
    logger.warning("dashboard flush failed: %s", e)


async def start_flush_loop() -> asyncio.Task:
  """Start background task that flushes stats to DB every FLUSH_INTERVAL_SECONDS."""
  async def _loop():
    while True:
      await asyncio.sleep(FLUSH_INTERVAL_SECONDS)
      flush_to_db()

  task = asyncio.create_task(_loop())
  return task


# ---------------------------------------------------------------------------
# Dashboard formatting
# ---------------------------------------------------------------------------

def _format_tokens(count: int) -> str:
  if count >= 1_000_000:
    return f"{count / 1_000_000:.1f}M"
  if count >= 1_000:
    return f"{count / 1_000:.1f}K"
  return str(count)


def _format_period_stats(chat_id: str, period_type: str, period_key: str, label: str) -> str:
  """Format stats for one period."""
  # Flush buffer first to include latest data
  flush_to_db()

  stats = get_stats(chat_id, period_type, period_key)
  if not stats:
    return f"*{label}* ({period_key})\n  No data yet."

  msgs = stats.get("messages_processed", 0)
  tags = stats.get("bot_tags", 0)
  name_mentions = stats.get("bot_name_mentions", 0)
  llm1 = stats.get("llm1_calls", 0)
  llm2 = stats.get("llm2_calls", 0)
  responses = stats.get("responses_sent", 0)
  stickers = stats.get("stickers_sent", 0)
  errors = stats.get("errors", 0)
  llm1_in = stats.get("llm1_input_tokens", 0)
  llm1_out = stats.get("llm1_output_tokens", 0)
  llm2_in = stats.get("llm2_input_tokens", 0)
  llm2_out = stats.get("llm2_output_tokens", 0)
  total_in = llm1_in + llm2_in
  total_out = llm1_out + llm2_out

  lines = [
    f"*{label}* ({period_key})",
    f"  Messages: {msgs}",
    f"  Bot tagged: {tags} | Name mentioned: {name_mentions}",
    f"  LLM1: {llm1} calls | LLM2: {llm2} calls",
    f"  Tokens: {_format_tokens(total_in)} in / {_format_tokens(total_out)} out",
    f"    LLM1: {_format_tokens(llm1_in)} in / {_format_tokens(llm1_out)} out",
    f"    LLM2: {_format_tokens(llm2_in)} in / {_format_tokens(llm2_out)} out",
    f"  Responses: {responses} | Stickers: {stickers}",
    f"  Errors: {errors}",
  ]
  return "\n".join(lines)


def get_dashboard_text(chat_id: str) -> str:
  """Generate full dashboard text for a chat."""
  periods = _period_keys()
  labels = {"daily": "Today", "weekly": "This Week", "monthly": "This Month"}

  sections: list[str] = ["*Dashboard*\n"]
  for period_type, period_key in periods:
    label = labels.get(period_type, period_type)
    sections.append(_format_period_stats(chat_id, period_type, period_key, label))

  # Top users from monthly period
  monthly_key = next((pk for pt, pk in periods if pt == "monthly"), None)
  if monthly_key:
    top = get_top_users(chat_id, "monthly", monthly_key, limit=5)
    if top:
      sections.append("*Top Users (This Month)*")
      for i, (ref, name, count) in enumerate(top, 1):
        display = name if name else ref
        sections.append(f"  {i}. {display} ({ref}) — {count}x")

  return "\n\n".join(sections)
