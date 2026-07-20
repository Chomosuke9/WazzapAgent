"""SubAgent environment configuration."""
from __future__ import annotations

import os
from urllib.parse import urlsplit

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
SUBAGENT_OUTPUT_DOWNLOAD_TIMEOUT_S = _parse_positive_float(
  os.getenv("SUBAGENT_OUTPUT_DOWNLOAD_TIMEOUT_S"), 300.0
)
SUBAGENT_STEER_CONSUME_TIMEOUT_S = _parse_positive_float(
  os.getenv("SUBAGENT_STEER_CONSUME_TIMEOUT_S"), 30.0
)

# NOTE: SUBAGENT_ENABLED_DEFAULT is consumed by the Node gateway
# (src/config.ts -> openAccountPersistence), which seeds the per-tenant
# __global__ settings row ONCE on first boot. The bridge then reads the
# effective default from that row via get_subagent_enabled() (the __global__
# fallback). It is intentionally NOT read here — a bridge-side constant would
# never reach the DB fallback and silently do nothing.

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

# Maximum file size (in bytes) to inline as base64 in the /execute payload.
# Larger files use the authenticated resumable-upload protocol.
# Default 50 MB. Set to 0 to disable inlining entirely.
SUBAGENT_MAX_INLINE_FILE_BYTES = _parse_non_negative_int(
  os.getenv("SUBAGENT_MAX_INLINE_FILE_BYTES"), 50 * 1024 * 1024
)
SUBAGENT_MAX_INLINE_TOTAL_BYTES = _parse_non_negative_int(
  os.getenv("SUBAGENT_MAX_INLINE_TOTAL_BYTES"), 50 * 1024 * 1024
)


# ---------------------------------------------------------------------------
# Call-time env accessors (Step 14 — centralization).
#
# Read on each call (not frozen at import) to preserve historical behaviour;
# parsing/defaults are byte-identical to the original inline reads. These keep
# ``os.getenv`` confined to config modules while logic modules (main.py,
# subagent/output.py, subagent/webhook_server.py) import these accessors.
# ---------------------------------------------------------------------------

def subagent_webhook_url_env() -> str | None:
  return os.getenv("SUBAGENT_WEBHOOK_URL")


def subagent_webhook_host_env() -> str:
  """Bind host for the local sub-agent callback webhook server.

  Local-only callback URLs bind loopback.  A configured non-loopback callback
  URL (for example ``host.docker.internal``) implies that the callback must be
  reachable from another network namespace, so the safe functional default is
  ``0.0.0.0``.  Operators can always override this explicitly.
  """
  configured = os.getenv("SUBAGENT_WEBHOOK_HOST")
  if configured and configured.strip():
    return configured.strip()
  callback_url = os.getenv("SUBAGENT_WEBHOOK_URL", "")
  hostname = (urlsplit(callback_url).hostname or "").lower()
  if hostname and hostname not in {"localhost", "127.0.0.1", "::1"}:
    return "0.0.0.0"
  return "127.0.0.1"


def subagent_webhook_token_env() -> str | None:
  """Optional shared secret required on sub-agent callback requests."""
  value = os.getenv("SUBAGENT_WEBHOOK_TOKEN")
  return value if value else None


def subagent_api_token_env() -> str | None:
  """Optional Bearer credential for main-agent requests to WazzapSubAgents."""
  value = os.getenv("SUBAGENT_API_TOKEN")
  return value if value else None


def data_dir_env() -> str | None:
  """Node's default-tenant root, used to mirror its media-dir selection."""
  return os.getenv("DATA_DIR")


def media_dir_env() -> str | None:
  return os.getenv("MEDIA_DIR")


def subagent_input_staging_dir_env() -> str | None:
  return os.getenv("SUBAGENT_INPUT_STAGING_DIR")


def subagent_webhook_max_body_bytes_raw() -> str:
  return os.getenv("SUBAGENT_WEBHOOK_MAX_BODY_BYTES", str(200 * 1024 * 1024))
