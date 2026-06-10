"""SubAgent environment configuration."""
from __future__ import annotations

import os

from ..config import _parse_positive_float, _parse_non_negative_int

SUBAGENT_URL = os.getenv("SUBAGENT_URL", "http://localhost:5000")
SUBAGENT_WEBHOOK_PORT = _parse_non_negative_int(os.getenv("SUBAGENT_WEBHOOK_PORT"), 8081)
SUBAGENT_WEBHOOK_URL = os.getenv(
  "SUBAGENT_WEBHOOK_URL",
  f"http://localhost:{SUBAGENT_WEBHOOK_PORT}/subagent/callback",
)

# Submit retry tunables — used by SubAgentClient.submit() so transient
# rate-limits / 5xx / network blips don't immediately fail the whole task.
SUBAGENT_SUBMIT_RETRY_MAX = _parse_non_negative_int(os.getenv("SUBAGENT_SUBMIT_RETRY_MAX"), 3)
SUBAGENT_SUBMIT_RETRY_BASE_BACKOFF = _parse_positive_float(
  os.getenv("SUBAGENT_SUBMIT_RETRY_BASE_BACKOFF"), 1.0
)
SUBAGENT_SUBMIT_RETRY_MAX_BACKOFF = _parse_positive_float(
  os.getenv("SUBAGENT_SUBMIT_RETRY_MAX_BACKOFF"), 30.0
)
SUBAGENT_HTTP_TIMEOUT = _parse_positive_float(os.getenv("SUBAGENT_HTTP_TIMEOUT"), 30.0)

# Whether the execute_subtask tool is enabled by default for new chats.
# Can be overridden per-chat via DB (the /subagent command toggles the
# database row, which takes precedence over this default).
SUBAGENT_ENABLED_DEFAULT = os.getenv("SUBAGENT_ENABLED_DEFAULT", "false").lower() == "true"

# Maximum time (in seconds) to wait for the sub-agent to call back via the
# always-on webhook server. The webhook server auto-restarts on crash so
# this is a safety net only — if it fires, the sub-agent service itself
# has likely crashed or the network is partitioned. Default 300s (5 min).
# NOTE: This timeout resets each time a progress webhook is received
# (keepalive), so it only fires when the sub-agent goes completely silent.
SUBAGENT_WAIT_TIMEOUT_S = _parse_positive_float(os.getenv("SUBAGENT_WAIT_TIMEOUT_S"), 300.0)

# Absolute maximum wall-clock time (in seconds) for a sub-agent task,
# regardless of progress keepalives. This prevents a runaway sub-agent
# from keeping the bridge waiting indefinitely. Default 1800s (30 min).
SUBAGENT_MAX_WAIT_S = _parse_positive_float(os.getenv("SUBAGENT_MAX_WAIT_S"), 1800.0)

# Bounds for context that gets fed back to LLM2 so a noisy sub-agent
# cannot blow up the context window of subsequent turns.
SUBAGENT_REPORT_MAX_CHARS = _parse_non_negative_int(os.getenv("SUBAGENT_REPORT_MAX_CHARS"), 4096)
SUBAGENT_PROGRESS_DETAIL_MAX_CHARS = _parse_non_negative_int(
  os.getenv("SUBAGENT_PROGRESS_DETAIL_MAX_CHARS"), 500
)

# Maximum file size (in bytes) to inline as base64 in the /execute payload
# for cross-machine deployments. Files larger than this are sent as path
# references only (backward-compatible single-machine behavior).
# Default 50 MB. Set to 0 to disable inlining entirely.
SUBAGENT_MAX_INLINE_FILE_BYTES = _parse_non_negative_int(
  os.getenv("SUBAGENT_MAX_INLINE_FILE_BYTES"), 50 * 1024 * 1024
)
