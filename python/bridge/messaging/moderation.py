from __future__ import annotations

from ..log import setup_logging

logger = setup_logging()


def _merge_payload_attachments(payloads: list[dict], base_payload: dict) -> dict:
  merged = dict(base_payload)
  merged_attachments: list[dict] = []
  seen_keys: set[str] = set()
  for payload in payloads:
    attachments = payload.get("attachments") or []
    if not isinstance(attachments, list):
      continue
    # Each attachment belongs to the message it arrived on. ``merged`` keeps
    # only ``base_payload`` (the LAST burst message)'s top-level
    # contextMsgId/messageId, so once attachments from several messages are
    # unioned here that single id no longer identifies most of them. Stamp
    # every attachment with its OWN source ids so on-demand media download
    # (``materialize_visual_media``) fetches each against the message that
    # actually holds it. Without this, an image sent before a follow-up text
    # would be downloaded against the text message — the gateway rightly
    # replies ``unsupported media type`` and the image is never seen.
    src_ctx_id = payload.get("contextMsgId")
    src_message_id = payload.get("messageId")
    for attachment in attachments:
      if not isinstance(attachment, dict):
        continue
      path = str(attachment.get("path") or "").strip()
      kind = str(attachment.get("kind") or "").strip().lower()
      mime = str(attachment.get("mime") or "").strip().lower()
      file_name = str(attachment.get("fileName") or "").strip().lower()
      dedup_key = path or f"{kind}|{mime}|{file_name}"
      if dedup_key in seen_keys:
        continue
      seen_keys.add(dedup_key)
      # Copy so the source payload's attachment dict is left untouched.
      stamped = dict(attachment)
      if src_ctx_id and not stamped.get("contextMsgId"):
        stamped["contextMsgId"] = src_ctx_id
      if src_message_id and not stamped.get("messageId"):
        stamped["messageId"] = src_message_id
      merged_attachments.append(stamped)
  merged["attachments"] = merged_attachments
  return merged
