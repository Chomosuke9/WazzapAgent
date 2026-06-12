# wasocket/__init__.py
#
# Public surface of the pure-Python WaSocket SDK (Step 27 — replaces the
# minimal Step 22 package marker).
#
# This module is intentionally logic-free: it only re-exports the SDK's public
# names so callers can write ``from wasocket import make_wa_socket, WaSocket``.
#
# Exports (CONTRACT.md §4 / §7 / §2):
#   - make_wa_socket   — the factory
#   - WaSocket         — the public socket class
#   - WhatsAppMessage  — the inbound "message" model (CONTRACT §7)
#   - the WaSocketError hierarchy (CONTRACT §2) for convenience

from .errors import (
    InvalidTargetError,
    NotFoundError,
    NotGroupError,
    PermissionDeniedError,
    SendFailedError,
    TimeoutError,
    WaSocketError,
)
from .events import WhatsAppMessage
from .socket import WaSocket, make_wa_socket

__all__ = [
    # factory + class
    "make_wa_socket",
    "WaSocket",
    # inbound message model (CONTRACT §7)
    "WhatsAppMessage",
    # error hierarchy (CONTRACT §2)
    "WaSocketError",
    "NotFoundError",
    "NotGroupError",
    "PermissionDeniedError",
    "InvalidTargetError",
    "SendFailedError",
    "TimeoutError",
]
