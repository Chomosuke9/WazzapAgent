"""WaSocket SDK exception hierarchy.

This is the first (leaf) module of the pure-Python WaSocket SDK. It defines the
exceptions raised when an action fails — either via an ``error`` frame, an
``action_ack`` with ``ok=false``, or a client-side ack-wait timeout.

The string codes carried by each subclass MUST exactly equal the stable
``ErrorCode`` values defined in CONTRACT.md §2:

    not_found, not_group, permission_denied, invalid_target, send_failed, timeout

This module is intentionally dependency-free: it MUST NOT import
``websockets``/``asyncio``, define frame dataclasses, or touch the transport.
"""

from __future__ import annotations

from typing import Dict, Optional, Type


class WaSocketError(Exception):
    """Base error for all WaSocket SDK failures.

    Carries the protocol-level fields from an ``error`` frame or a failed
    ``action_ack`` (CONTRACT.md §1.3):

    - ``code``: the stable :data:`ErrorCode` string (CONTRACT.md §2), or ``None``
      when the originating frame had no/unknown code.
    - ``detail``: human-readable detail message.
    - ``request_id``: the ``requestId`` the failure correlates to, if any.
    - ``action``: the action type that failed (e.g. ``"delete_message"``), if any.
    """

    #: The CONTRACT.md §2 code this class represents. ``None`` on the base class
    #: (used when an error frame carries an unknown/absent code).
    code: Optional[str] = None

    def __init__(
        self,
        detail: Optional[str] = None,
        *,
        code: Optional[str] = None,
        request_id: Optional[str] = None,
        action: Optional[str] = None,
    ) -> None:
        # Prefer an explicitly supplied code; otherwise fall back to the
        # class-level code (set on each subclass).
        self.code = code if code is not None else type(self).code
        self.detail = detail
        self.request_id = request_id
        self.action = action
        super().__init__(self.__str__())

    def __str__(self) -> str:
        code = self.code if self.code is not None else "unknown"
        parts = [code]
        if self.detail:
            parts.append(str(self.detail))
        suffix = ": ".join(parts)
        meta = []
        if self.action:
            meta.append(f"action={self.action}")
        if self.request_id:
            meta.append(f"request_id={self.request_id}")
        if meta:
            return f"{suffix} ({', '.join(meta)})"
        return suffix

    def __repr__(self) -> str:  # pragma: no cover - convenience only
        return (
            f"{type(self).__name__}(code={self.code!r}, detail={self.detail!r}, "
            f"request_id={self.request_id!r}, action={self.action!r})"
        )


class NotFoundError(WaSocketError):
    """``not_found`` — target message/resource not found."""

    code = "not_found"


class NotGroupError(WaSocketError):
    """``not_group`` — action requires a group chat but was sent to a private chat."""

    code = "not_group"


class PermissionDeniedError(WaSocketError):
    """``permission_denied`` — bot lacks the required role (admin/superadmin)."""

    code = "permission_denied"


class InvalidTargetError(WaSocketError):
    """``invalid_target`` — senderRef/contextMsgId malformed/unresolvable, or unsupported action."""

    code = "invalid_target"


class SendFailedError(WaSocketError):
    """``send_failed`` — underlying WhatsApp send failed (network/media/rate-limit/socket)."""

    code = "send_failed"


class TimeoutError(WaSocketError):  # noqa: A001 - intentionally shadows builtin per CONTRACT/spec
    """``timeout`` — operation timed out (server-side deadline or SDK ack-wait expiry).

    Note: this intentionally shadows the builtin ``TimeoutError`` *within this
    module*. The CONTRACT/spec mandates this name. Code that needs the builtin
    while this module is in scope should reference ``builtins.TimeoutError``.
    """

    code = "timeout"


#: Stable code string → exception class (CONTRACT.md §2).
CODE_TO_CLASS: Dict[str, Type[WaSocketError]] = {
    NotFoundError.code: NotFoundError,
    NotGroupError.code: NotGroupError,
    PermissionDeniedError.code: PermissionDeniedError,
    InvalidTargetError.code: InvalidTargetError,
    SendFailedError.code: SendFailedError,
    TimeoutError.code: TimeoutError,
}


def _build(
    code: Optional[str],
    detail: Optional[str],
    request_id: Optional[str],
    action: Optional[str],
) -> WaSocketError:
    """Construct the right subclass for ``code``; unknown/missing → base WaSocketError."""
    cls = CODE_TO_CLASS.get(code) if code is not None else None
    if cls is None:
        # Unknown or absent code → base error, preserving whatever code was given.
        return WaSocketError(detail, code=code, request_id=request_id, action=action)
    return cls(detail, request_id=request_id, action=action)


def from_error_frame(payload: dict) -> WaSocketError:
    """Build a :class:`WaSocketError` from an ``error`` frame payload (CONTRACT.md §1.3).

    Expected fields: ``code``, ``detail``, ``requestId``, ``action``.
    Unknown/missing ``code`` → base :class:`WaSocketError`.
    """
    payload = payload or {}
    code = payload.get("code")
    detail = payload.get("detail") or payload.get("message")
    request_id = payload.get("requestId")
    action = payload.get("action")
    return _build(code, detail, request_id, action)


def from_failed_ack(payload: dict) -> WaSocketError:
    """Build a :class:`WaSocketError` from a failed ``action_ack`` (``ok=false``).

    Uses the ack's ``code``/``detail`` (CONTRACT.md §1.3).
    Unknown/missing ``code`` → base :class:`WaSocketError`.
    """
    payload = payload or {}
    code = payload.get("code")
    detail = payload.get("detail")
    request_id = payload.get("requestId")
    action = payload.get("action")
    return _build(code, detail, request_id, action)
