from __future__ import annotations

try:
  from ..log import setup_logging
except ImportError:
  import sys
  from pathlib import Path
  sys.path.append(str(Path(__file__).resolve().parent.parent.parent))
  from bridge.log import setup_logging  # type: ignore

logger = setup_logging()


def _merge_payload_attachments(payloads: list[dict], base_payload: dict) -> dict:
  merged = dict(base_payload)
  merged_attachments: list[dict] = []
  seen_keys: set[str] = set()
  for payload in payloads:
    attachments = payload.get("attachments") or []
    if not isinstance(attachments, list):
      continue
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
      merged_attachments.append(attachment)
  merged["attachments"] = merged_attachments
  return merged
