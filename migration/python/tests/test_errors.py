"""Tests for the WaSocket SDK exception hierarchy (Step 22).

Import path: tests insert ``migration/python`` onto ``sys.path`` (matching the
existing test suite, e.g. test_tool_calls_and_permissions.py), so the SDK
imports as ``wasocket.errors``.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Ensure the SDK package is importable (migration/python on sys.path).
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from wasocket.errors import (
    CODE_TO_CLASS,
    InvalidTargetError,
    NotFoundError,
    NotGroupError,
    PermissionDeniedError,
    SendFailedError,
    TimeoutError,
    WaSocketError,
    from_error_frame,
    from_failed_ack,
)

# (code string, expected subclass) for all six CONTRACT.md §2 codes.
CODE_CASES = [
    ("not_found", NotFoundError),
    ("not_group", NotGroupError),
    ("permission_denied", PermissionDeniedError),
    ("invalid_target", InvalidTargetError),
    ("send_failed", SendFailedError),
    ("timeout", TimeoutError),
]


@pytest.mark.parametrize("code, cls", CODE_CASES)
def test_from_error_frame_round_trips_each_code(code, cls):
    payload = {
        "code": code,
        "detail": f"detail for {code}",
        "requestId": "send-123-000001",
        "action": "delete_message",
    }
    err = from_error_frame(payload)
    assert type(err) is cls
    assert err.code == code
    assert err.detail == f"detail for {code}"
    assert err.request_id == "send-123-000001"
    assert err.action == "delete_message"


def test_from_error_frame_uses_message_when_no_detail():
    err = from_error_frame({"code": "send_failed", "message": "boom"})
    assert type(err) is SendFailedError
    assert err.detail == "boom"


def test_from_error_frame_unknown_code_returns_base():
    err = from_error_frame({"code": "weird"})
    assert type(err) is WaSocketError
    # Base error preserves the unknown code verbatim.
    assert err.code == "weird"


def test_from_error_frame_missing_code_returns_base():
    err = from_error_frame({"detail": "no code here"})
    assert type(err) is WaSocketError
    assert err.code is None
    assert err.detail == "no code here"


def test_from_error_frame_empty_payload_returns_base():
    err = from_error_frame({})
    assert type(err) is WaSocketError
    assert err.code is None


def test_from_failed_ack_not_found():
    payload = {
        "ok": False,
        "code": "not_found",
        "detail": "contextMsgId 000999 not found",
        "requestId": "delete-1-000002",
        "action": "delete_message",
    }
    err = from_failed_ack(payload)
    assert type(err) is NotFoundError
    assert err.code == "not_found"
    assert err.detail == "contextMsgId 000999 not found"
    assert err.request_id == "delete-1-000002"
    assert err.action == "delete_message"


@pytest.mark.parametrize("code, cls", CODE_CASES)
def test_from_failed_ack_round_trips_each_code(code, cls):
    err = from_failed_ack({"ok": False, "code": code})
    assert type(err) is cls
    assert err.code == code


def test_from_failed_ack_unknown_code_returns_base():
    err = from_failed_ack({"ok": False, "code": "mystery"})
    assert type(err) is WaSocketError
    assert err.code == "mystery"


@pytest.mark.parametrize("code, cls", CODE_CASES)
def test_every_subclass_is_a_wasocketerror(code, cls):
    assert issubclass(cls, WaSocketError)
    assert isinstance(cls("x"), WaSocketError)


def test_code_to_class_table_matches_subclasses():
    assert CODE_TO_CLASS == {code: cls for code, cls in CODE_CASES}
    # Every mapped class carries the matching class-level code.
    for code, cls in CODE_TO_CLASS.items():
        assert cls.code == code


def test_base_error_str_includes_code_and_meta():
    err = NotFoundError("nope", request_id="r-1", action="delete_message")
    text = str(err)
    assert "not_found" in text
    assert "nope" in text
    assert "action=delete_message" in text
    assert "request_id=r-1" in text


def test_explicit_code_overrides_class_code():
    # Constructing a subclass with an explicit code should honor it.
    err = WaSocketError("d", code="custom")
    assert err.code == "custom"
