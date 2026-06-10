"""WhatsApp text formatting sanitization.

WhatsApp uses single-asterisk markup (*bold*, _italic_, ~strikethrough~).
LLMs trained on Markdown sometimes emit double-asterisk bold (**bold**) which
WhatsApp renders as literal asterisks instead of bold text.

This module provides :func:`sanitize_whatsapp_text` to convert Markdown-style
bold markers into WhatsApp-compatible ones before the text is sent outbound.
"""
from __future__ import annotations

import re

# Match **bold** markers — content must not start or end with whitespace so
# we don't accidentally collapse legitimate "*text* with *more*" patterns
# that happen to have adjacent asterisks from italic markers.
_DOUBLE_ASTERISK_RE = re.compile(r'\*\*(?!\s)(.+?)(?<!\s)\*\*')


def sanitize_whatsapp_text(text: str) -> str:
  """Convert ``**bold**`` (Markdown) to ``*bold*`` (WhatsApp).

  WhatsApp renders ``*text*`` as bold, but ``**text**`` shows up with
  literal asterisks.  This function normalises double-asterisk bold markers
  so LLM output looks correct in WhatsApp chats.

  Only bold (double asterisk) is converted; italic (``_text_``) and
  strikethrough (``~text~``) are already WhatsApp-compatible.
  """
  if not text:
    return text
  return _DOUBLE_ASTERISK_RE.sub(r'*\1*', text)