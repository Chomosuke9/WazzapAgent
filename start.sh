#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# start.sh — WazzapAgents process supervisor
#
# Starts both the Node.js gateway and Python bridge as child processes,
# ties their lifecycles, and restarts them automatically when either exits
# (e.g. after /update). Ctrl+C / SIGTERM triggers a clean shutdown with
# NO restart.
#
# Usage:
#   bash start.sh          # local dev (replaces needing 2 terminals)
#   exec bash start.sh     # called from ptero-bootstrap.sh after provisioning
#
# Environment:
#   PY_BIN        Override Python binary path (set by Pterodactyl bootstrap)
#   PYTHONPATH    Defaults to <project_root>/python if unset
#   NODE_GRACE_S  Seconds to wait for graceful shutdown (default: 10)
# ---------------------------------------------------------------------------
set -uo pipefail

# Always run from the project root (the directory this script lives in).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

log() { echo "[start] $*"; }

# ── Resolve Python binary: $PY_BIN → python3 → python ─────────────────────
PYTHON="${PY_BIN:-}"
if [ -z "$PYTHON" ]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="python3"
  elif command -v python >/dev/null 2>&1; then
    PYTHON="python"
  else
    PYTHON=""
  fi
fi

# ── Ensure PYTHONPATH includes our python/ dir ─────────────────────────────
export PYTHONPATH="${PYTHONPATH:-$SCRIPT_DIR/python}"

# ── Graceful shutdown ──────────────────────────────────────────────────────
GRACE_SECONDS="${NODE_GRACE_S:-10}"
NODE_PID=""
PY_PID=""
RESTART=true

graceful_stop() {
  # Send SIGTERM so each process runs its cleanup handlers:
  #   Node  → close WS clients, close WS server, close per-tenant DBs
  #   Python → stop webhook servers, checkpoint SQLite WAL, close DBs
  [ -n "$PY_PID" ]   && kill -TERM "$PY_PID"   2>/dev/null
  [ -n "$NODE_PID" ] && kill -TERM "$NODE_PID" 2>/dev/null

  # Wait up to $GRACE_SECONDS for both to exit cleanly.
  local deadline=$((SECONDS + GRACE_SECONDS))
  while [ $SECONDS -lt $deadline ]; do
    local alive=0
    [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null && alive=1
    [ -n "$PY_PID" ]   && kill -0 "$PY_PID"   2>/dev/null && alive=1
    [ $alive -eq 0 ] && break
    sleep 0.5
  done

  # Force-kill anything still alive (last resort).
  [ -n "$NODE_PID" ] && kill -0 "$NODE_PID" 2>/dev/null && { log "Node did not exit in time, sending SIGKILL"; kill -9 "$NODE_PID" 2>/dev/null; }
  [ -n "$PY_PID" ]   && kill -0 "$PY_PID"   2>/dev/null && { log "Python did not exit in time, sending SIGKILL"; kill -9 "$PY_PID" 2>/dev/null; }

  wait 2>/dev/null
  NODE_PID=""
  PY_PID=""
}

on_signal() {
  RESTART=false
  log "received signal, shutting down gracefully…"
  graceful_stop
}
trap on_signal SIGINT SIGTERM

# ── Main restart loop ──────────────────────────────────────────────────────
while $RESTART; do
  log "starting Node gateway…"
  node --import tsx src/index.ts &
  NODE_PID=$!

  # Node must be listening before Python dials in.
  sleep 3

  if [ -n "$PYTHON" ]; then
    log "starting Python bridge…"
    "$PYTHON" -m bridge.main &
    PY_PID=$!
  else
    log "WARN: Python not found — running gateway only (no LLM replies)."
    PY_PID=""
  fi

  # Block until either child exits.
  if [ -n "$PY_PID" ]; then
    wait -n "$NODE_PID" "$PY_PID" 2>/dev/null
  else
    wait "$NODE_PID" 2>/dev/null
  fi
  EXIT_CODE=$?

  # If we're still in restart mode (no signal received), clean up the
  # surviving process gracefully before looping.
  if $RESTART; then
    log "a process exited (code $EXIT_CODE), stopping the other gracefully…"
    graceful_stop
    log "restarting in 3 seconds…"
    sleep 3
  fi
done

log "shutdown complete."
exit "$EXIT_CODE"
