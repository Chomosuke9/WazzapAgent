"""Regression: the documented WS_* reconnect/heartbeat env vars must actually
feed the WaSocket transport (they were previously parsed nowhere)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bridge import config  # noqa: E402


def test_ws_transport_options_defaults(monkeypatch):
    for k in (
        "WS_RECONNECT_MS",
        "WS_RECONNECT_MAX_MS",
        "WS_RECONNECT_JITTER_RATIO",
        "WS_HEARTBEAT_INTERVAL_MS",
        "LLM_WS_TOKEN",
    ):
        monkeypatch.delenv(k, raising=False)
    opts = config.ws_transport_options()
    assert opts == {
        "base_ms": 5000.0,
        "max_ms": 60000.0,
        "jitter_ratio": 0.2,
        "heartbeat_interval_ms": 20000.0,
        "headers": {},
    }


def test_ws_transport_options_reads_env(monkeypatch):
    monkeypatch.delenv("LLM_WS_TOKEN", raising=False)
    monkeypatch.setenv("WS_RECONNECT_MS", "1000")
    monkeypatch.setenv("WS_RECONNECT_MAX_MS", "30000")
    monkeypatch.setenv("WS_RECONNECT_JITTER_RATIO", "0")
    monkeypatch.setenv("WS_HEARTBEAT_INTERVAL_MS", "10000")
    opts = config.ws_transport_options()
    assert opts == {
        "base_ms": 1000.0,
        "max_ms": 30000.0,
        "jitter_ratio": 0.0,
        "heartbeat_interval_ms": 10000.0,
        "headers": {},
    }


def test_ws_auth_headers(monkeypatch):
    monkeypatch.delenv("LLM_WS_TOKEN", raising=False)
    assert config.ws_auth_headers() == {}
    monkeypatch.setenv("LLM_WS_TOKEN", "  s3cret  ")
    assert config.ws_auth_headers() == {"Authorization": "Bearer s3cret"}


def test_token_flows_through_make_wa_socket_to_transport(monkeypatch):
    """End-to-end wiring: LLM_WS_TOKEN -> ws_transport_options -> make_wa_socket
    -> WSClientTransport._headers (which is passed to ws_connect as
    additional_headers)."""
    from wasocket import make_wa_socket

    monkeypatch.setenv("LLM_WS_TOKEN", "tok-123")
    sock = make_wa_socket("./data", **config.ws_transport_options())
    assert sock._transport._headers.get("Authorization") == "Bearer tok-123"

    monkeypatch.delenv("LLM_WS_TOKEN", raising=False)
    sock2 = make_wa_socket("./data", **config.ws_transport_options())
    assert "Authorization" not in sock2._transport._headers


def test_ws_transport_options_keys_match_transport_init():
    """Every key must be a real WSClientTransport __init__ kwarg, so they are
    forwarded (not silently swallowed/erroring) via make_wa_socket."""
    import inspect

    from wasocket.transport import WSClientTransport

    params = set(inspect.signature(WSClientTransport.__init__).parameters)
    assert set(config.ws_transport_options()).issubset(params)
