from __future__ import annotations

import asyncio
import contextlib
import json
import os
import time

from ..log import setup_logging
from .processing import _normalize_context_msg_id
from .format import sanitize_whatsapp_text

logger = setup_logging()


async def _ws_send(ws, frame: str) -> None:
  """Transmit a pre-serialised JSON frame through the WaSocket transport.

  Step 28 transport seam: every ``send_*`` helper below builds its wire frame
  as a ``json.dumps({...})`` string and hands it here. The first arg ``ws`` is
  now a :class:`wasocket.WaSocket` (the agent's per-tenant client) rather than a
  raw ``websockets`` connection.

  We route the ALREADY-BUILT frame through the socket's transport
  (``ws._transport.send``) instead of the SDK's high-level action methods
  (``ws.send_message`` etc.) on purpose: the high-level methods allocate their
  OWN ``requestId``, whereas the bridge still allocates its own ``requestId``
  via ``_make_request_id`` (Step 31 trims this) and keys its provisional-history
  hydration / ``pending_send_request_chat`` / ``pending_subagent_attachments`` /
  ``pending_run_command_chat`` correlation on it. Keeping the bridge's
  ``requestId`` on the wire is what lets the Step-29 ``action_ack`` event handler
  match the ack back to its pending entry verbatim. The transport accepts a
  pre-serialised string as-is and is best-effort (dropped if not connected),
  mirroring the old ``ws.send`` semantics for transient action frames.
  """
  await ws._transport.send(frame)


async def send_message(
  ws,
  chat_id: str,
  text: str,
  reply_to: str | None,
  *,
  request_id: str,
):
  # Sanitize WhatsApp formatting before sending: LLMs sometimes produce
  # **bold** (Markdown) which renders as literal asterisks in WhatsApp
  # instead of bold text. Convert to *bold* (WhatsApp-compatible).
  text = sanitize_whatsapp_text(text) if text else text
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "send_message",
      "request_id": request_id,
      "reply_to": reply_to,
      "text_preview": text[:200],
      "text_len": len(text or ""),
    },
  )
  await _ws_send(ws, 
    json.dumps(
      {
        "type": "send_message",
        "payload": {
          "requestId": request_id,
          "chatId": chat_id,
          "text": text,
          "replyTo": reply_to,
        },
      }
    )
  )


async def send_attachment(
  ws,
  chat_id: str,
  attachment_path: str,
  kind: str,
  *,
  request_id: str,
  file_name: str | None = None,
  reply_to: str | None = None,
  caption: str | None = None,
  mime: str | None = None,
  thumbnail_base64: str | None = None,
):
  """Send a single attachment to a chat as its own WhatsApp message.

  ``kind`` must be one of: ``image``, ``video``, ``audio``, ``sticker``,
  ``document``. The Node gateway (``src/wa/outbound.js::sendOutgoing``) already
  accepts an ``attachments`` array on the ``send_message`` payload — this
  helper just builds a payload with exactly one attachment so each file lands
  in its own bubble.

  ``mime`` is forwarded to Node so the gateway can set Baileys'
  ``content.mimetype`` explicitly. Without it Baileys falls back to its own
  guess, which for unfamiliar files is ``application/pdf`` — that produces
  WhatsApp messages that can't be opened. Pass the value returned by
  :func:`bridge.subagent.output.detect_kind` whenever possible.

  ``thumbnail_base64`` is an optional base64-encoded JPEG thumbnail for
  document previews. When provided for a ``document`` kind attachment,
  the Node gateway includes it as ``jpegThumbnail`` so WhatsApp shows a
  preview instead of a blank white rectangle.
  """
  if not attachment_path or not kind:
    return
  # Sanitize WhatsApp formatting in caption before sending, same as
  # send_message() does for plain text.
  if caption:
    caption = sanitize_whatsapp_text(caption)
  normalized_reply_to = _normalize_context_msg_id(reply_to) if reply_to else None
  attachment: dict = {"kind": kind, "path": attachment_path}
  # Always include fileName — use the explicit name if provided,
  # otherwise fall back to the basename of the path so WhatsApp
  # always shows the original filename instead of a generic "file".
  attachment["fileName"] = file_name or os.path.basename(attachment_path)
  if caption:
    attachment["caption"] = caption
  if mime:
    attachment["mime"] = mime
  if thumbnail_base64:
    attachment["thumbnailBase64"] = thumbnail_base64
  payload: dict = {
    "requestId": request_id,
    "chatId": chat_id,
    "attachments": [attachment],
  }
  if normalized_reply_to:
    payload["replyTo"] = normalized_reply_to
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "send_attachment",
      "request_id": request_id,
      "kind": kind,
      "attachment_path": attachment_path,
      "file_name": file_name,
      "mime": mime,
      "has_thumbnail": thumbnail_base64 is not None,
      "reply_to": normalized_reply_to,
    },
  )
  await _ws_send(ws, json.dumps({"type": "send_message", "payload": payload}))


async def send_delete_message(
  ws,
  chat_id: str,
  context_msg_id: str | None,
  *,
  request_id: str,
):
  normalized_context_msg_id = _normalize_context_msg_id(context_msg_id)
  if not normalized_context_msg_id:
    return
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "delete_message",
      "request_id": request_id,
      "context_msg_id": normalized_context_msg_id,
    },
  )
  await _ws_send(ws, 
    json.dumps(
      {
        "type": "delete_message",
        "payload": {
          "requestId": request_id,
          "chatId": chat_id,
          "contextMsgId": normalized_context_msg_id,
        },
      }
    )
  )


async def send_kick_member(
  ws,
  chat_id: str,
  targets: list[dict[str, str]],
  *,
  request_id: str,
  mode: str = "partial_success",
  auto_reply_anchor: bool = False,
):
  if not targets:
    return
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "kick_member",
      "request_id": request_id,
      "targets": targets,
      "mode": mode,
      "auto_reply_anchor": auto_reply_anchor,
    },
  )
  await _ws_send(ws, 
    json.dumps(
      {
        "type": "kick_member",
        "payload": {
          "requestId": request_id,
          "chatId": chat_id,
          "targets": targets,
          "mode": mode,
          "autoReplyAnchor": auto_reply_anchor,
        },
      }
    )
  )


async def send_run_command(
  ws,
  chat_id: str,
  command_text: str,
  context_msg_id: str | None,
  *,
  request_id: str,
):
  """Ask the gateway to silently execute a slash command.

  Unlike :func:`send_message`, this does NOT post the command text to the
  WhatsApp chat — the gateway parses ``command_text`` with
  ``parseSlashCommand`` and invokes the same ``handleCommandListener`` that
  human-typed commands use. ``context_msg_id`` is forwarded as the anchor so
  commands like ``/sticker`` and ``/catch`` can resolve the quoted media.

  The gateway returns an ``action_ack`` with ``action == "run_command"`` and a
  ``result.command`` string we can use to log a synthetic
  ``Command <name> executed successfully`` line into the LLM history.
  """
  if not command_text or not isinstance(command_text, str):
    return
  normalized_context_msg_id = (
    _normalize_context_msg_id(context_msg_id) if context_msg_id else None
  )
  payload: dict = {
    "requestId": request_id,
    "chatId": chat_id,
    "command": command_text,
  }
  if normalized_context_msg_id:
    payload["contextMsgId"] = normalized_context_msg_id
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "run_command",
      "request_id": request_id,
      "command_preview": command_text[:80],
      "context_msg_id": normalized_context_msg_id,
    },
  )
  await _ws_send(ws, json.dumps({"type": "run_command", "payload": payload}))


async def send_react_message(
  ws,
  chat_id: str,
  context_msg_id: str | None,
  emoji: str | None,
  *,
  request_id: str,
):
  normalized_context_msg_id = _normalize_context_msg_id(context_msg_id)
  if not normalized_context_msg_id or not emoji:
    return
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "react_message",
      "request_id": request_id,
      "context_msg_id": normalized_context_msg_id,
      "emoji": emoji,
    },
  )
  await _ws_send(ws, 
    json.dumps(
      {
        "type": "react_message",
        "payload": {
          "requestId": request_id,
          "chatId": chat_id,
          "contextMsgId": normalized_context_msg_id,
          "emoji": emoji,
        },
      }
    )
  )


async def send_sticker(
  ws,
  chat_id: str,
  sticker_path: str,
  reply_to: str | None,
  *,
  request_id: str,
):
  normalized_reply_to = _normalize_context_msg_id(reply_to) if reply_to else None
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "send_sticker",
      "request_id": request_id,
      "sticker_path": sticker_path,
      "reply_to": normalized_reply_to,
    },
  )
  payload: dict = {
    "requestId": request_id,
    "chatId": chat_id,
    "attachments": [{"kind": "sticker", "path": sticker_path}],
  }
  if normalized_reply_to:
    payload["replyTo"] = normalized_reply_to
  await _ws_send(ws, 
    json.dumps({"type": "send_message", "payload": payload})
  )


async def send_lottie_sticker_payload(
  ws,
  chat_id: str,
  lottie_payload_json: str,
  reply_to: str | None = None,
  *,
  request_id: str,
):
  """Relay a Lottie/premium sticker using its stored JSON payload.

  Unlike ``send_sticker`` (which reads a .webp file), this sends the original
  ``lottieStickerMessage`` JSON that was captured during ``/addsticker``.
  The Node gateway reconstructs and relays the message verbatim via
  ``generateWAMessageFromContent`` + ``relayMessage``, preserving the
  Lottie animation fully.

  ``lottie_payload_json`` must be the JSON string stored in
  ``stickers.lottie_payload`` by addsticker.js.

  ``reply_to`` is an optional contextMsgId to reply to. The Node gateway
  resolves it to the original WhatsApp message ID and injects
  ``contextInfo`` into the inner ``stickerMessage`` before relaying.
  """
  normalized_reply_to = _normalize_context_msg_id(reply_to) if reply_to else None
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "relay_lottie_sticker",
      "request_id": request_id,
      "reply_to": normalized_reply_to,
    },
  )
  payload: dict = {
    "requestId": request_id,
    "chatId": chat_id,
    "lottiePayload": lottie_payload_json,
  }
  if normalized_reply_to:
    payload["replyTo"] = normalized_reply_to
  await _ws_send(ws, 
    json.dumps({
      "type": "relay_lottie_sticker",
      "payload": payload,
    })
  )


async def send_quiz(
  ws,
  chat_id: str,
  question: str,
  choices: list[dict],
  *,
  request_id: str,
  reply_to: str | None = None,
  footer: str | None = None,
):
  """Send a multiple-choice quiz message with quick-reply buttons.

  ``choices`` is a list of dicts with keys:
    - ``label``     — single letter shown in history (e.g. "A")
    - ``fullText``  — full choice text shown in the message body
    - ``shortText`` — ≤20-char button label (enforced by actions.py)

  The Node gateway builds the message body from ``question`` + numbered
  choices, then attaches one quick-reply button per choice whose
  ``display_text`` = ``"<label>. <shortText>"`` and
  ``id`` = ``"qz:<label>"``.

  When the user taps a button, WhatsApp sends back a
  ``templateButtonReplyMessage`` with ``selectedDisplayText`` =
  ``"<label>. <shortText>"`` — this is forwarded to Python as a plain
  incoming message text so LLM2 can evaluate the answer normally.
  """
  # Sanitize WhatsApp formatting before sending, same as send_message() does
  # for plain text. Converts **bold** (Markdown) → *bold* (WhatsApp-compatible).
  question = sanitize_whatsapp_text(question) if question else question
  if footer:
    footer = sanitize_whatsapp_text(footer)
  normalized_reply_to = _normalize_context_msg_id(reply_to) if reply_to else None
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "send_quiz",
      "request_id": request_id,
      "question_preview": question[:80],
      "num_choices": len(choices),
      "reply_to": normalized_reply_to,
    },
  )
  payload: dict = {
    "requestId": request_id,
    "chatId": chat_id,
    "question": question,
    "choices": choices,
  }
  if normalized_reply_to:
    payload["replyTo"] = normalized_reply_to
  if footer:
    payload["footer"] = footer
  await _ws_send(ws, json.dumps({"type": "send_quiz", "payload": payload}))


async def send_copy_code(
  ws,
  chat_id: str,
  code: str,
  *,
  display_text: str = "Copy Code",
  reply_to: str | None = None,
  quoted_preview_text: str | None = None,
  request_id: str,
):
  """Send a cta_copy interactive message so the user can tap to copy *code*.

  The Node gateway renders this as a NativeFlow interactive message with a
  single ``cta_copy`` button.  The button label defaults to "Copy Code" but
  can be overridden via *display_text*.

  When *quoted_preview_text* is provided, the CTA Copy bubble will appear as
  a reply with a dummy stanzaId, and the quoted preview will show the given
  text (typically the code snippet) instead of any real message content.
  """
  normalized_reply_to = _normalize_context_msg_id(reply_to) if reply_to else None
  logger.debug(
    "outbound",
    extra={
      "chat_id": chat_id,
      "action": "send_copy_code",
      "request_id": request_id,
      "reply_to": normalized_reply_to,
      "quoted_preview_text_len": len(quoted_preview_text) if quoted_preview_text else None,
      "code_len": len(code or ""),
      "display_text": display_text,
    },
  )
  payload: dict = {
    "requestId": request_id,
    "chatId": chat_id,
    "code": code,
    "displayText": display_text,
  }
  if normalized_reply_to:
    payload["replyTo"] = normalized_reply_to
  if quoted_preview_text:
    payload["quotedPreviewText"] = quoted_preview_text
  await _ws_send(ws, json.dumps({"type": "send_copy_code", "payload": payload}))


async def send_mark_read(
  ws,
  chat_id: str,
  message_id: str | None,
  participant: str | None = None,
):
  """Send a read receipt signal to the gateway."""
  if not message_id:
    return
  payload: dict = {"chatId": chat_id, "messageId": message_id}
  if participant:
    payload["participant"] = participant
  try:
    await _ws_send(ws, json.dumps({"type": "mark_read", "payload": payload}))
  except Exception as err:
    logger.debug("send_mark_read failed: %s", err)


async def send_typing(ws, chat_id: str, composing: bool = True):
  """Send typing presence to the gateway."""
  presence_type = "composing" if composing else "paused"
  try:
    await _ws_send(ws, 
      json.dumps({"type": "send_presence", "payload": {"chatId": chat_id, "type": presence_type}})
    )
  except Exception as err:
    logger.debug("send_typing failed: %s", err)


@contextlib.asynccontextmanager
async def typing_indicator(ws, chat_id: str, interval: float = 8.0):
  """Context manager that keeps the typing indicator alive by refreshing it periodically.

  WhatsApp's typing indicator expires after ~10-15 seconds on the client side.
  This sends a fresh 'composing' presence every *interval* seconds so the
  indicator stays visible even when LLM2 takes a long time to respond.
  """

  async def _keep_alive():
    try:
      while True:
        await asyncio.sleep(interval)
        await send_typing(ws, chat_id, composing=True)
    except asyncio.CancelledError:
      pass

  await send_typing(ws, chat_id, composing=True)
  task = asyncio.create_task(_keep_alive())
  try:
    yield
  finally:
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
      await task
    await send_typing(ws, chat_id, composing=False)
