#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ptero-bootstrap.sh — run WazzapAgents on a FIXED node-only Pterodactyl image
# (e.g. ghcr.io/ptero-eggs/yolks:nodejs_24) with NO custom image, NO custom egg,
# and NO root.
#
# What it does (all into the persistent /home/container volume, cached):
#   1. Provision a relocatable standalone CPython (python-build-standalone).
#   2. pip install the bridge's Python requirements into that Python.
#   3. Provision a static ffmpeg (best-effort; only needed for /sticker video).
#   4. Ensure Node deps are present (incl. tsx).
#   5. Run the Node gateway + the Python bridge together (loopback), and tie
#      their lifecycles so Pterodactyl restarts the whole server cleanly.
#
# Config is read from env vars (set them via the egg's CUSTOM_ENVIRONMENT_VARIABLES
# as KEY=value;KEY2=value2). Versions can be overridden with PBS_RELEASE /
# PYTHON_VERSION / FFMPEG_STATIC_URL if the defaults ever rot.
# ---------------------------------------------------------------------------
set -uo pipefail
cd /home/container || exit 1

log() { echo "[bootstrap] $*"; }

# --- Tunables (override via env if a pinned asset disappears) ---------------
PYTHON_VERSION="${PYTHON_VERSION:-3.11.9}"
PBS_RELEASE="${PBS_RELEASE:-20240415}"
PY_DIR="/home/container/.python"
PY_BIN="$PY_DIR/bin/python3"
FFMPEG_DIR="/home/container/.ffmpeg"
FFMPEG_BIN="$FFMPEG_DIR/ffmpeg"
FFPROBE_BIN="$FFMPEG_DIR/ffprobe"
QR_DIR="/home/container/.qrencode"
QR_BIN="$QR_DIR/usr/bin/qrencode"

# --- State + transport env (everything persists under /home/container) ------
export DATA_DIR="${DATA_DIR:-/home/container/data}"
export FOLDER_PATH="${FOLDER_PATH:-$DATA_DIR}"
export MEDIA_DIR="${MEDIA_DIR:-$DATA_DIR/media}"
export STICKERS_DIR="${STICKERS_DIR:-$DATA_DIR/stickers}"
export WS_LISTEN_PORT="${WS_LISTEN_PORT:-${SERVER_PORT:-3000}}"
export WS_BIND_HOST="${WS_BIND_HOST:-127.0.0.1}"
export NODE_URL="${NODE_URL:-ws://127.0.0.1:${WS_LISTEN_PORT}}"
export PYTHONPATH="/home/container/python"
export PYTHONUNBUFFERED=1
mkdir -p "$DATA_DIR"

# --- Architecture mapping ---------------------------------------------------
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64)  PBS_ARCH="x86_64-unknown-linux-gnu";  FF_ARCH="amd64"; DEB_ARCH="amd64"; DEB_TRIPLET="x86_64-linux-gnu" ;;
  aarch64|arm64) PBS_ARCH="aarch64-unknown-linux-gnu"; FF_ARCH="arm64"; DEB_ARCH="arm64"; DEB_TRIPLET="aarch64-linux-gnu" ;;
  *) log "WARN: unknown arch '$arch'; assuming x86_64"; PBS_ARCH="x86_64-unknown-linux-gnu"; FF_ARCH="amd64"; DEB_ARCH="amd64"; DEB_TRIPLET="x86_64-linux-gnu" ;;
esac

# This deployment is pinned to Node 24 so native prebuild selection is
# deterministic. Fail early instead of silently compiling for another ABI.
node_version="$(node -p "process.version")"
node_major="$(node -p "process.versions.node.split('.')[0]")"
node_abi="$(node -p "process.versions.modules")"
if [ "$node_major" != "24" ]; then
  log "ERROR: this deployment requires nodejs_24; found $node_version (ABI $node_abi)"
  exit 1
fi
log "using $node_version (ABI $node_abi)"

# --- download <url> <dest> : curl -> wget -> node fetch fallback ------------
download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    node -e 'const fs=require("fs");fetch(process.argv[1]).then(r=>{if(!r.ok)process.exit(1);return r.arrayBuffer();}).then(b=>fs.writeFileSync(process.argv[2],Buffer.from(b))).catch(()=>process.exit(1))' "$url" "$dest"
  fi
}

# --- 1) Portable Python -----------------------------------------------------
if [ ! -x "$PY_BIN" ]; then
  log "provisioning portable Python ${PYTHON_VERSION} (${PBS_ARCH})..."
  url="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${PBS_ARCH}-install_only.tar.gz"
  tmp="/home/container/.python.tar.gz"
  if download "$url" "$tmp"; then
    # The archive extracts to a top-level "python/" dir, which would collide
    # with our bridge source dir — extract to a temp dir then move.
    rm -rf /home/container/.pytmp && mkdir -p /home/container/.pytmp
    if tar -xzf "$tmp" -C /home/container/.pytmp; then
      rm -rf "$PY_DIR"
      mv /home/container/.pytmp/python "$PY_DIR"
      log "portable Python ready at $PY_BIN"
    else
      log "WARN: failed to extract Python archive"
    fi
    rm -rf /home/container/.pytmp "$tmp"
  else
    log "WARN: failed to download portable Python from $url"
  fi
fi

# --- 2) Python deps (cached by requirements.txt hash) -----------------------
if [ -x "$PY_BIN" ]; then
  req_hash="$( (sha1sum requirements.txt 2>/dev/null || shasum requirements.txt 2>/dev/null) | awk '{print $1}')"
  marker="$PY_DIR/.deps-${req_hash}"
  if [ ! -f "$marker" ]; then
    log "installing Python dependencies (this runs once per requirements change)..."
    "$PY_BIN" -m pip install --no-cache-dir --upgrade pip >/dev/null 2>&1 || true
    if "$PY_BIN" -m pip install --no-cache-dir -r requirements.txt; then
      : > "$marker"
      log "Python dependencies installed"
    else
      log "WARN: Python deps install failed; the LLM bridge may not start"
    fi
  fi
fi

# --- 3) Static ffmpeg (best-effort; only used by /sticker video) ------------
if [ ! -x "$FFMPEG_BIN" ]; then
  log "provisioning static ffmpeg (best-effort)..."
  url="${FFMPEG_STATIC_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-${FF_ARCH}-static.tar.xz}"
  tmp="/home/container/.ffmpeg.tar.xz"
  if download "$url" "$tmp"; then
    rm -rf /home/container/.fftmp && mkdir -p /home/container/.fftmp "$FFMPEG_DIR"
    if tar -xJf "$tmp" -C /home/container/.fftmp 2>/dev/null; then
      f="$(find /home/container/.fftmp -type f -name ffmpeg | head -n1)"
      p="$(find /home/container/.fftmp -type f -name ffprobe | head -n1)"
      [ -n "$f" ] && cp "$f" "$FFMPEG_BIN" && chmod +x "$FFMPEG_BIN"
      [ -n "$p" ] && cp "$p" "$FFPROBE_BIN" && chmod +x "$FFPROBE_BIN"
      log "ffmpeg ready at $FFMPEG_BIN"
    else
      log "WARN: could not extract ffmpeg (.xz tools missing); /sticker video disabled"
    fi
    rm -rf /home/container/.fftmp "$tmp"
  else
    log "WARN: ffmpeg download failed; /sticker video disabled"
  fi
fi
if [ -x "$FFMPEG_BIN" ]; then
  export FFMPEG_PATH="$FFMPEG_BIN"
  [ -x "$FFPROBE_BIN" ] && export FFPROBE_PATH="$FFPROBE_BIN"
  export PATH="$FFMPEG_DIR:$PATH"
fi

# --- 3b) qrencode (best-effort; renders the WhatsApp login QR) --------------
# The Node gateway shells out to `qrencode -t ANSIUTF8` to draw the pairing QR
# (src/wa/connection.ts → printQrInTerminal). The node-only yolk image ships no
# qrencode, so provision it WITHOUT root by extracting the Debian .deb packages
# (qrencode + libqrencode4 + libpng16-16) into the volume and pointing
# PATH + LD_LIBRARY_PATH at them. Defaults use a pinned Debian package set that
# remains self-contained on the Node 24 yolk; override the *_DEB_URL env vars
# if a provider uses an incompatible base.
# Best-effort: if it fails, the QR prints as a raw string — code-based login via
# WA_PAIRING_NUMBER needs no QR and is the recommended headless path.
if [ ! -x "$QR_BIN" ]; then
  log "provisioning qrencode (best-effort)..."
  DEB_BASE="https://deb.debian.org/debian/pool/main"
  QRENCODE_DEB_URL="${QRENCODE_DEB_URL:-$DEB_BASE/q/qrencode/qrencode_4.1.1-1_${DEB_ARCH}.deb}"
  LIBQRENCODE_DEB_URL="${LIBQRENCODE_DEB_URL:-$DEB_BASE/q/qrencode/libqrencode4_4.1.1-1_${DEB_ARCH}.deb}"
  LIBPNG_DEB_URL="${LIBPNG_DEB_URL:-$DEB_BASE/libp/libpng1.6/libpng16-16_1.6.39-2+deb12u5_${DEB_ARCH}.deb}"
  rm -rf /home/container/.qrtmp && mkdir -p /home/container/.qrtmp "$QR_DIR"
  qr_ok=1
  # unpack one .deb's payload into $QR_DIR (dpkg-deb preferred; ar+tar fallback)
  unpack_deb() {
    local deb="$1"
    if command -v dpkg-deb >/dev/null 2>&1; then
      dpkg-deb -x "$deb" "$QR_DIR"
    elif command -v ar >/dev/null 2>&1; then
      ( cd /home/container/.qrtmp && ar x "$deb" && tar -xf data.tar.* -C "$QR_DIR" \
        && rm -f data.tar.* control.tar.* debian-binary )
    else
      return 2
    fi
  }
  # libpng16-16 is often already on the image; treat its download as optional.
  for url in "$LIBPNG_DEB_URL:opt" "$LIBQRENCODE_DEB_URL:req" "$QRENCODE_DEB_URL:req"; do
    u="${url%:*}"; kind="${url##*:}"
    deb="/home/container/.qrtmp/$(basename "$u")"
    if download "$u" "$deb"; then
      unpack_deb "$deb"; rc=$?
      if [ "$rc" != 0 ]; then
        if [ "$rc" = 2 ]; then
          log "WARN: neither dpkg-deb nor ar available; cannot unpack qrencode"
        else
          log "WARN: failed to unpack $(basename "$u")"
        fi
        [ "$kind" = req ] && qr_ok=0
      fi
    else
      log "WARN: failed to download $(basename "$u")"
      [ "$kind" = req ] && qr_ok=0
    fi
  done
  rm -rf /home/container/.qrtmp
  if [ "$qr_ok" = 1 ] && [ -x "$QR_BIN" ]; then
    log "qrencode ready at $QR_BIN"
  else
    log "WARN: qrencode provisioning failed; the login QR will print as a raw string. Use WA_PAIRING_NUMBER for code-based login instead."
    rm -rf "$QR_DIR"
  fi
fi
if [ -x "$QR_BIN" ]; then
  export PATH="$QR_DIR/usr/bin:$PATH"
  export LD_LIBRARY_PATH="$QR_DIR/usr/lib/${DEB_TRIPLET}:$QR_DIR/usr/lib:${LD_LIBRARY_PATH:-}"
fi

# --- 4) Node deps (the generic egg runs `npm install`, but ensure tsx too) --
if [ ! -x "/home/container/node_modules/.bin/tsx" ]; then
  log "installing Node dependencies (including dev for tsx)..."
  npm install --include=dev || log "WARN: npm install failed"
fi

# --- 4b) Ensure the better-sqlite3 native binding matches Node 24's ABI ------
# better-sqlite3 is a native addon: its `better_sqlite3.node` must match the
# running Node ABI. The Pterodactyl target is Node 24 (ABI 137), for which the
# pinned better-sqlite3 version publishes official Linux x64/arm64 prebuilds.
# If a stale binding remains after an image change, run prebuild-install
# directly. Do not fall back to node-gyp here: compiling inside a constrained
# game-server container is slow and can appear to hang indefinitely.
better_sqlite3_healthy() {
  node -e "new (require('better-sqlite3'))(':memory:').close()" >/dev/null 2>&1
}

install_better_sqlite3_prebuild() {
  local module_dir="/home/container/node_modules/better-sqlite3"
  local prebuild_cli

  [ -d "$module_dir" ] || return 1
  prebuild_cli="$(node -e "const fs = require('fs'); process.stdout.write(require.resolve('prebuild-install/bin.js', { paths: [fs.realpathSync('$module_dir')] }))" 2>/dev/null || true)"
  [ -n "$prebuild_cli" ] || return 1

  (
    cd "$module_dir" || exit 1
    unset npm_config_build_from_source npm_config_build_from_source_better_sqlite3
    node "$prebuild_cli" --verbose --force
  )
}

if ! better_sqlite3_healthy; then
  log "better-sqlite3 binding missing/mismatched; downloading the official prebuilt for Node ABI $node_abi..."
  install_better_sqlite3_prebuild || true
  if better_sqlite3_healthy; then
    log "better-sqlite3 prebuilt binding ready"
  else
    log "ERROR: better-sqlite3 prebuilt install failed. Select nodejs_24 and ensure GitHub release downloads are allowed; this bootstrap repair path does not compile from source."
    exit 1
  fi
fi

# --- 5) Hand off to the shared process supervisor ----------------------------
# start.sh starts both Node + Python, ties their lifecycles, and auto-restarts
# on /update. All provisioned env vars (PY_BIN, PYTHONPATH, FFMPEG_PATH, etc.)
# are inherited. exec replaces this shell so signals propagate cleanly.
export PY_BIN="$PY_BIN"
log "handing off to start.sh…"
exec bash start.sh

