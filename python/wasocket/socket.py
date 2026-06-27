# wasocket/socket.py
#
# WaSocket — the public surface of the pure-Python WaSocket SDK (Step 27).
#
# It ties together the lower layers built in Steps 22-26:
#   - errors.py       (Step 22) — the WaSocketError hierarchy + frame->error builders
#   - protocol.py     (Step 23) — frozen frame dataclasses + encode/decode
#   - events.py       (Step 24) — event-name constants + WhatsAppMessage (CONTRACT §7)
#   - correlation.py  (Step 25) — make_request_id + PendingAcks (CONTRACT §3)
#   - transport.py    (Step 26) — resilient WS client (handshake/backoff/heartbeat)
#
# This module implements CONTRACT.md §4 VERBATIM:
#   - lifecycle: connect / disconnect / is_connected / folder_path
#   - on(event) decorator (the §4 event list)
#   - action methods: build a frame (protocol.py), allocate a request_id
#     (correlation.make_request_id), send it (transport.send), AWAIT the ack
#     future, and return its `result` dict (or raise the mapped WaSocketError
#     on an `error` frame / failed ack / ack-wait timeout). The ONLY two
#     fire-and-forget methods are `mark_read` and `send_presence` (§1.2 / §4):
#     they send and return immediately (None, no pending future).
#   - frame router (the transport's `on_frame`):
#       incoming_message      -> emit "message" (WhatsAppMessage.from_payload)
#       whatsapp_status       -> emit "status"  ({status, reason, folderPath})
#       hello_ack             -> emit "ready"   (None)        [defensive; see below]
#       error                 -> reject pending future AND emit "error"
#       action_ack / send_ack -> resolve pending future AND re-emit (D3 dual)
#       control events (§1.5) -> emit by their type name
#
# NOTE on "ready": the transport consumes the handshake `hello_ack` internally
# (CONTRACT §1.1) and never forwards it through `on_frame`; instead it invokes
# its `on_status("open")` callback once the handshake completes. WaSocket wires
# that callback to fire the "ready" event (and to flip the handshake-done flag),
# so `await connect()` fires "ready" after `hello_ack` on every (re)connect. The
# `hello_ack` branch in the router is kept purely defensively in case a future
# transport ever forwards it.
#
# Scope guard (per Step 27): NO agent/LLM/DB logic, and NO `bridge.*` import —
# this SDK is agent-agnostic.

from __future__ import annotations

import asyncio
import dataclasses
import logging
from typing import Any, Awaitable, Callable, Dict, List, Optional, Union

from . import errors, events, protocol
from .correlation import PendingAcks, make_request_id
from .errors import WaSocketError
from .events import WhatsAppMessage
from .transport import WSClientTransport

logger = logging.getLogger("wasocket.socket")

# A handler may be sync or async; it receives a single event-specific payload.
Handler = Callable[[Any], Union[None, Awaitable[None]]]


def _retrieve_future_outcome(future: "asyncio.Future") -> None:
    """Retrieve a fire-and-forget action future's outcome.

    Attached to the unawaited futures registered for caller-supplied
    ``request_id`` sends (the bridge path, see :meth:`WaSocket._dispatch_action`).
    Calling :meth:`asyncio.Future.exception` marks any rejection (timeout /
    disconnect) as retrieved so asyncio never logs an "exception was never
    retrieved" warning for these intentionally-unawaited futures.
    """
    if future.cancelled():
        return
    future.exception()

# The six §1.5 control events, surfaced to handlers by their type name.
_CONTROL_TYPES = frozenset(
    {
        events.CLEAR_HISTORY,
        events.SET_LLM2_MODEL,
        events.INVALIDATE_LLM2_MODEL,
        events.INVALIDATE_DEFAULT_MODEL,
        events.INVALIDATE_CHAT_SETTINGS,
        events.SET_SUBAGENT_ENABLED,
        events.SCHEDULE_TASK,
    }
)

#: The complete set of event names accepted by :meth:`WaSocket.on` (CONTRACT §4).
VALID_EVENTS = frozenset(
    {
        events.MESSAGE,
        events.STATUS,
        events.READY,
        events.ERROR,
        events.ACTION_ACK,
        events.SEND_ACK,
    }
) | _CONTROL_TYPES


class WaSocket:
    """The public WaSocket SDK surface (CONTRACT.md §4).

    A :class:`WaSocket` serves exactly one tenant ``folder_path``. It owns a
    :class:`~wasocket.transport.WSClientTransport`, a :class:`PendingAcks` map,
    and a registry of event handlers.

    Usage::

        sock = make_wa_socket("/abs/tenant")

        @sock.on("message")
        async def on_message(msg):  # msg is a WhatsAppMessage
            ...

        await sock.connect("ws://localhost:3000")
        result = await sock.send_message(chat_id, "hi")  # awaits the ack
        await sock.disconnect()
    """

    def __init__(
        self,
        folder_path: str,
        *,
        transport: Optional[WSClientTransport] = None,
        ack_timeout: float = 30.0,
        download_ack_timeout: float = 75.0,
        **transport_options: Any,
    ) -> None:
        self._folder_path = folder_path
        self._transport = transport or WSClientTransport(**transport_options)
        self._pending = PendingAcks()
        self._handlers: Dict[str, List[Handler]] = {}
        self._ack_timeout = ack_timeout
        # `download_media` re-downloads bytes from WhatsApp on demand (gateway
        # budget DOWNLOAD_TIMEOUT_MS, default 60s). Its ack window must exceed
        # that budget, or a slow download is abandoned before the gateway can
        # ack and the file silently never lands. Kept distinct from the generic
        # 30s ack so every other action still fails fast.
        self._download_ack_timeout = max(download_ack_timeout, ack_timeout)
        # True only between a successful handshake ("open") and the next "close".
        self._handshake_done = False

    # ------------------------------------------------------------------ #
    # Properties (CONTRACT §4)
    # ------------------------------------------------------------------ #

    @property
    def folder_path(self) -> str:
        """The tenant folder this socket serves (the account key)."""
        return self._folder_path

    @property
    def is_connected(self) -> bool:
        """True iff the transport is OPEN *and* the handshake has completed."""
        return self._transport.is_connected() and self._handshake_done

    # ------------------------------------------------------------------ #
    # Lifecycle (CONTRACT §4)
    # ------------------------------------------------------------------ #

    async def connect(self, node_url: str = "ws://localhost:3000") -> None:
        """Open the transport, send ``hello``, and await ``hello_ack``.

        Idempotent if already connected. The transport keeps retrying on
        transient failures in the background; this call resolves once the first
        handshake completes (the ``"ready"`` event fires before it returns).
        """
        if self.is_connected:
            return
        hello = protocol.Hello(folder_path=self._folder_path)
        await self._transport.connect(
            node_url, hello, self._route_frame, self._on_transport_status
        )

    async def disconnect(self) -> None:
        """Graceful close. Never raises (CONTRACT §4)."""
        try:
            await self._transport.close()
        except Exception as err:  # pragma: no cover - defensive; close() must not raise
            logger.warning("disconnect: transport close failed: %r", err)
        finally:
            self._handshake_done = False
            # Fail fast: reject any in-flight awaited actions so callers don't
            # hang for the full ack timeout after the socket is torn down.
            self._pending.reject_all(WaSocketError("WaSocket disconnected"))

    # ------------------------------------------------------------------ #
    # Event registration (CONTRACT §4)
    # ------------------------------------------------------------------ #

    def on(self, event: str) -> Callable[[Handler], Handler]:
        """Register a handler for ``event`` (decorator).

        ``event`` must be one of :data:`VALID_EVENTS`. Multiple handlers may be
        registered for the same event; they are invoked in registration order.
        The handler may be sync or async; its payload depends on the event
        (CONTRACT §4):

        - ``"message"``  -> :class:`WhatsAppMessage`
        - ``"status"``   -> ``dict {"status", "reason", "folderPath"}``
        - ``"ready"``    -> ``None``
        - ``"error"``    -> :class:`WaSocketError`
        - ``"action_ack"`` / ``"send_ack"`` -> :class:`protocol.AckResult`
        - control events -> ``dict`` (top-level §1.5 fields)
        """
        if event not in VALID_EVENTS:
            raise ValueError(
                f"unknown event {event!r}; valid events: {sorted(VALID_EVENTS)}"
            )

        def decorator(handler: Handler) -> Handler:
            self._handlers.setdefault(event, []).append(handler)
            return handler

        return decorator

    # ------------------------------------------------------------------ #
    # Action methods (CONTRACT §4) — all await the ack unless noted otherwise.
    # ------------------------------------------------------------------ #

    async def send_message(
        self,
        destination: str,
        text: Optional[str] = None,
        *,
        reply_to: Optional[str] = None,
        attachments: Optional[List[dict]] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Send a text message (+ optional attachments). Returns the
        ``send_message`` ActionResult (``{sent: [...], replyTo}``) when the SDK
        allocates the ``request_id``; returns ``None`` when the caller supplies
        its own ``request_id`` (see :meth:`_dispatch_action`).

        Raises ``NotFoundError`` (bad ``reply_to``), ``SendFailedError``,
        ``InvalidTargetError`` or ``TimeoutError``.

        Per CONTRACT §1.2 the wire ``send_message`` payload has no mentions
        field — mentions are conveyed inline in ``text`` via the
        ``@Name (senderRef)`` convention — so there is no ``mentions`` parameter.
        """
        rid = request_id if request_id is not None else make_request_id("send")
        frame = protocol.SendMessageAction(
            request_id=rid,
            chat_id=destination,
            text=text,
            reply_to=reply_to,
            attachments=attachments,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def send_quiz(
        self,
        destination: str,
        question: str,
        choices: List[dict],
        *,
        reply_to: Optional[str] = None,
        footer: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Send a multiple-choice quiz. Raises ``SendFailedError``,
        ``InvalidTargetError`` or ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("quiz")
        frame = protocol.SendQuizAction(
            request_id=rid,
            chat_id=destination,
            question=question,
            choices=tuple(choices),
            reply_to=reply_to,
            footer=footer,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def react(
        self,
        destination: str,
        msg_id: str,
        emoji: str,
        *,
        request_id: Optional[str] = None,
    ) -> dict:
        """React to ``msg_id`` (a contextMsgId) with ``emoji``. Raises
        ``NotFoundError``, ``SendFailedError`` or ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("react")
        frame = protocol.ReactMessageAction(
            request_id=rid,
            chat_id=destination,
            context_msg_id=msg_id,
            emoji=emoji,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def delete_message(
        self,
        destination: str,
        msg_id: str,
        *,
        request_id: Optional[str] = None,
    ) -> dict:
        """Delete ``msg_id`` (a contextMsgId). Raises ``NotFoundError``,
        ``PermissionDeniedError``, ``SendFailedError`` or ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("delete")
        frame = protocol.DeleteMessageAction(
            request_id=rid,
            chat_id=destination,
            context_msg_id=msg_id,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def kick(
        self,
        group_id: str,
        members: List[dict],
        *,
        mode: str = "partial_success",
        request_id: Optional[str] = None,
    ) -> dict:
        """Remove ``members`` (``[{senderRef}, ...]``) from a
        group. Raises ``NotGroupError``, ``PermissionDeniedError``,
        ``InvalidTargetError``, ``SendFailedError`` or ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("kick")
        frame = protocol.KickMemberAction(
            request_id=rid,
            chat_id=group_id,
            targets=tuple(members),
            mode=mode,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def send_presence(self, chat_id: str, presence: str) -> None:
        """FIRE-AND-FORGET typing presence (CONTRACT §1.2/§4): no requestId, no
        ack, no pending future. ``presence`` is ``"composing"`` | ``"paused"``."""
        frame = protocol.SendPresenceAction(chat_id=chat_id, type=presence)
        await self._transport.send(frame)
        return None

    async def mark_read(
        self,
        chat_id: str,
        message_id: str,
        participant: Optional[str] = None,
    ) -> None:
        """FIRE-AND-FORGET read receipt (CONTRACT §1.2/§4): no requestId, no
        ack, no pending future."""
        frame = protocol.MarkReadAction(
            chat_id=chat_id,
            message_id=message_id,
            participant=participant,
        )
        await self._transport.send(frame)
        return None

    async def send_buttons(
        self,
        destination: str,
        body: str,
        buttons: List[dict],
        *,
        footer: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Send a NativeFlow buttons message. Raises ``SendFailedError`` or
        ``TimeoutError``.

        Per CONTRACT §1.2 the wire ``send_buttons`` payload has no ``replyTo``
        field, so there is no ``reply_to`` parameter."""
        rid = request_id if request_id is not None else make_request_id("buttons")
        frame = protocol.SendButtonsAction(
            request_id=rid,
            chat_id=destination,
            text=body,
            buttons=tuple(buttons),
            footer=footer,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def send_carousel(
        self,
        destination: str,
        cards: List[dict],
        *,
        body: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Send a swipeable carousel. Raises ``SendFailedError`` or
        ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("carousel")
        frame = protocol.SendCarouselAction(
            request_id=rid,
            chat_id=destination,
            cards=tuple(cards),
            text=body,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def send_copy_code(
        self,
        destination: str,
        code: str,
        *,
        display_text: str = "Copy Code",
        reply_to: Optional[str] = None,
        quoted_preview_text: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Send a CTA copy-code message. Raises ``SendFailedError`` or
        ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("copy")
        frame = protocol.SendCopyCodeAction(
            request_id=rid,
            chat_id=destination,
            code=code,
            display_text=display_text,
            reply_to=reply_to,
            quoted_preview_text=quoted_preview_text,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def relay_lottie_sticker(
        self,
        destination: str,
        lottie_payload: str,
        *,
        reply_to: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Relay a stored Lottie/premium sticker using its original JSON
        ``lottie_payload`` (CONTRACT §1.2 ``relay_lottie_sticker``), preserving
        the full animation. Raises ``SendFailedError`` or ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("sticker")
        frame = protocol.RelayLottieStickerAction(
            request_id=rid,
            chat_id=destination,
            lottie_payload=lottie_payload,
            reply_to=reply_to,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def send_sticker(
        self,
        destination: str,
        path: str,
        *,
        reply_to: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Send a sticker by building a ``send_message`` frame with a single
        sticker attachment (CONTRACT §4). Raises ``SendFailedError`` or
        ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("sticker")
        frame = protocol.SendMessageAction(
            request_id=rid,
            chat_id=destination,
            reply_to=reply_to,
            attachments=[{"kind": "sticker", "path": path}],
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def run_command(
        self,
        chat_id: str,
        command: str,
        *,
        context_msg_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Silently execute a slash command on the gateway. Returns the
        ``run_command`` ActionResult (``{command, error?}``). Raises
        ``InvalidTargetError`` or ``TimeoutError``."""
        rid = request_id if request_id is not None else make_request_id("cmd")
        frame = protocol.RunCommandAction(
            request_id=rid,
            chat_id=chat_id,
            command=command,
            context_msg_id=context_msg_id,
        )
        return await self._dispatch_action(
            frame, rid, caller_supplied=request_id is not None
        )

    async def download_media(
        self,
        chat_id: str,
        *,
        context_msg_id: Optional[str] = None,
        message_id: Optional[str] = None,
        request_id: Optional[str] = None,
    ) -> dict:
        """Fetch the media bytes for a previously-forwarded attachment on demand
        (feature 8 lazy media). The gateway re-downloads from its cached message
        proto and returns the attachment ActionResult (``{path, mime, kind,
        fileName, ...}``). Identify the message by ``context_msg_id`` or
        ``message_id``. Raises ``NotFoundError`` (proto evicted / no media),
        ``InvalidTargetError`` or ``TimeoutError``.

        Uses a longer ack window than the generic action timeout: the gateway
        re-downloads the bytes from WhatsApp on demand (budget
        ``DOWNLOAD_TIMEOUT_MS``, default 60s), so a 30s ack wait would abandon
        a still-in-progress download — the file would never land and the caller
        (vision / sticker / sub-agent) would silently get nothing."""
        rid = request_id if request_id is not None else make_request_id("dl")
        frame = protocol.DownloadMediaAction(
            request_id=rid,
            chat_id=chat_id,
            context_msg_id=context_msg_id,
            message_id=message_id,
        )
        return await self._dispatch_action(
            frame,
            rid,
            caller_supplied=request_id is not None,
            timeout=self._download_ack_timeout,
        )

    # ------------------------------------------------------------------ #
    # Internal: await-ack plumbing
    # ------------------------------------------------------------------ #

    async def _dispatch_action(
        self,
        action_frame: Any,
        request_id: str,
        *,
        caller_supplied: bool,
        timeout: Optional[float] = None,
    ) -> Optional[dict]:
        """Send an action frame, routing it through :class:`PendingAcks`.

        Two modes, selected by whether the caller supplied its own
        ``request_id``:

        * **SDK-allocated id** (``caller_supplied=False``): register the pending
          future, send, and AWAIT the ack — returning its ``result`` dict (or
          raising the mapped :class:`WaSocketError` / timeout). This is the
          public-SDK ergonomics preserved verbatim from before this seam.

        * **Caller-supplied id** (``caller_supplied=True``, the bridge path):
          still register in :class:`PendingAcks` so the ack/timeout net cleans
          the entry up, but DO NOT block the caller. The bridge keeps its own
          ``requestId``→pending-map correlation and hydrates on the
          ``action_ack`` EVENT; it populates that map AFTER this call returns,
          so awaiting the ack here would invert that ordering and break
          hydration. A done-callback retrieves the unawaited future's outcome
          so a timeout/disconnect rejection is never logged as an unretrieved
          exception.
        """
        future = self._pending.register(
            request_id, timeout=timeout if timeout is not None else self._ack_timeout
        )
        if caller_supplied:
            future.add_done_callback(_retrieve_future_outcome)
            await self._transport.send(action_frame)
            return None
        await self._transport.send(action_frame)
        return await future

    # ------------------------------------------------------------------ #
    # Internal: transport callbacks
    # ------------------------------------------------------------------ #

    async def _on_transport_status(self, status: str) -> None:
        """Transport connection-status callback ("open"/"closed").

        ``"open"`` means the ``hello``/``hello_ack`` handshake just completed —
        flip the handshake-done flag and fire the ``"ready"`` event. ``"closed"``
        clears the flag. (This is the *transport* connection status, distinct
        from the WhatsApp ``"status"`` event carried by ``whatsapp_status``.)
        """
        if status == "open":
            self._handshake_done = True
            await self._emit(events.READY, None)
        elif status == "closed":
            self._handshake_done = False

    async def _route_frame(self, type_str: str, parsed: object) -> None:
        """The transport's ``on_frame`` callback: route a decoded frame.

        ``parsed`` is the matching frozen dataclass for known frame types, or
        the raw decoded ``dict`` for types not in ``protocol``'s frame table
        (``incoming_message``, ``send_ack``).
        """
        try:
            if type_str == "incoming_message":
                payload = parsed.get("payload") if isinstance(parsed, dict) else None
                msg = WhatsAppMessage.from_payload(payload or {})
                await self._emit(events.MESSAGE, msg)
                return

            if type_str == "whatsapp_status":
                ev = parsed  # protocol.WhatsAppStatusEvent
                await self._emit(
                    events.STATUS,
                    {
                        "status": ev.status,
                        "reason": ev.reason,
                        "folderPath": ev.folder_path,
                    },
                )
                return

            if type_str == "hello_ack":
                # Defensive: the transport normally consumes hello_ack during the
                # handshake and signals via on_status("open") instead.
                await self._emit(events.READY, None)
                return

            if type_str == "error":
                err = parsed  # protocol.ErrorResult
                wa_err = errors.from_error_frame(
                    {
                        "code": err.code,
                        "detail": err.detail,
                        "message": err.message,
                        "requestId": err.request_id,
                        "action": err.action,
                    }
                )
                if err.request_id:
                    self._pending.reject(err.request_id, wa_err)
                await self._emit(events.ERROR, wa_err)
                return

            if type_str == "action_ack":
                ack = parsed  # protocol.AckResult
                if ack.ok:
                    # D3: resolve the awaiting future with the result dict ...
                    self._pending.resolve(ack.request_id, ack.result or {})
                else:
                    self._pending.reject(
                        ack.request_id,
                        errors.from_failed_ack(
                            {
                                "code": ack.code,
                                "detail": ack.detail,
                                "requestId": ack.request_id,
                                "action": ack.action,
                            }
                        ),
                    )
                # ... and re-emit it as an event so agents can also observe it.
                await self._emit(events.ACTION_ACK, ack)
                return

            if type_str == "send_ack":
                # Legacy companion of a successful send_message (CONTRACT §1.3).
                # Resolution is authoritative on action_ack (which carries the
                # result); send_ack carries only requestId, so we re-emit it as
                # an AckResult event (CONTRACT §4) without re-resolving.
                payload = parsed.get("payload") if isinstance(parsed, dict) else None
                payload = payload or {}
                ack = protocol.AckResult(
                    request_id=payload.get("requestId"),
                    action="send_message",
                    ok=True,
                    detail="sent",
                )
                await self._emit(events.SEND_ACK, ack)
                return

            if type_str in _CONTROL_TYPES:
                await self._emit(type_str, self._control_dict(type_str, parsed))
                return

            # Unknown / unrouted frame — ignore (do not kill the pump).
            logger.debug("unrouted frame type=%r", type_str)
        except Exception as err:  # pragma: no cover - defensive
            # A routing error must never kill the transport's frame pump.
            logger.exception("frame router error (type=%r): %r", type_str, err)

    @staticmethod
    def _control_dict(type_str: str, parsed: Any) -> dict:
        """Build the §1.5 top-level control-event dict (camelCase + type)."""
        body = {
            protocol.snake_to_camel(k): v
            for k, v in dataclasses.asdict(parsed).items()
        }
        body["type"] = type_str
        return body

    # ------------------------------------------------------------------ #
    # Internal: safe handler dispatch
    # ------------------------------------------------------------------ #

    async def _emit(self, event: str, payload: Any) -> None:
        """Invoke every handler for ``event``, awaiting coroutine handlers.

        A handler raising must NOT propagate (it would otherwise kill the
        transport frame pump). Each handler is isolated with try/except.
        """
        for handler in list(self._handlers.get(event, [])):
            try:
                result = handler(payload)
                if asyncio.iscoroutine(result):
                    await result
            except Exception as err:  # pragma: no cover - handler isolation
                logger.exception("handler for %r raised: %r", event, err)


def make_wa_socket(
    folder_path: str,
    *,
    ack_timeout: float = 30.0,
    download_ack_timeout: float = 75.0,
    **transport_options: Any,
) -> WaSocket:
    """Factory: build a :class:`WaSocket` for ``folder_path`` (CONTRACT §4).

    ``ack_timeout`` and any ``transport_options`` (e.g. ``base_ms``, ``max_ms``,
    ``jitter_ratio``, ``heartbeat_interval_ms``) are forwarded to the underlying
    :class:`~wasocket.transport.WSClientTransport`. These are additive knobs;
    the contract signature is ``make_wa_socket(folder_path) -> WaSocket``.

    ``download_ack_timeout`` is the longer ack window for ``download_media``
    only (the gateway re-downloads bytes from WhatsApp on demand); it must
    exceed the gateway ``DOWNLOAD_TIMEOUT_MS`` budget (default 60s).
    """
    return WaSocket(
        folder_path,
        ack_timeout=ack_timeout,
        download_ack_timeout=download_ack_timeout,
        **transport_options,
    )


__all__ = ["make_wa_socket", "WaSocket", "VALID_EVENTS"]
