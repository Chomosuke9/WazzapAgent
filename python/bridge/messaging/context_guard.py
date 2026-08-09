"""Detect user attempts to imitate the bridge's serialized LLM context.

The bridge renders chat history with trusted structural markers such as
``[#000123] 10:42``, ``REPLYING TO [#000122]``, and ``SYSTEM:``.  A WhatsApp
user who sends the same syntax could otherwise create a second, forged context
entry inside their own message.  This module is deliberately pure: callers
decide which payloads are trusted and how a detected message is represented.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass


BLOCKED_CONTEXT_INJECTION_TEXT = (
  "[BLOCKED, THIS MESSAGE DETECTED TO HAVE CONTEXT INJECTION]"
)


@dataclass(frozen=True)
class ContextInjectionSignals:
  human_sender: bool
  message_header: bool
  internal_header: bool
  reply_marker: bool
  bot_sender: bool
  system_marker: bool


@dataclass(frozen=True)
class ContextInjectionResult:
  detected: bool
  risk_score: int
  signals: ContextInjectionSignals


_FLAGS = re.IGNORECASE | re.MULTILINE

# Matches the bridge's human sender line, including its optional role label:
#   Agus Kebab (2j3yy9): hello
#   Agus Kebab (2j3yy9) (admin): hello
# The role text is intentionally unrestricted because any role-position token
# following a six-character senderRef is forged context syntax.
_HUMAN_SENDER_RE = re.compile(
  r"^[^\S\n]*[^\n:]+?[^\S\n]+\([a-z0-9]{6}\)"
  r"(?:[^\S\n]+\([^)\n]{1,32}\))?[^\S\n]*:",
  _FLAGS,
)

_MESSAGE_HEADER_RE = re.compile(
  r"^[^\S\n]*\[#\d{6}\][^\S\n]+(?:[01]\d|2[0-3]):[0-5]\d[^\S\n]*$",
  _FLAGS,
)

_INTERNAL_HEADER_RE = re.compile(
  r"^[^\S\n]*\[#(?:pending|system)\][^\S\n]+(?:[01]\d|2[0-3]):[0-5]\d[^\S\n]*$",
  _FLAGS,
)

_REPLY_RE = re.compile(
  r"^[^\S\n]*REPLYING[^\S\n]+TO[^\S\n]+\[#\d{6}\][^\S\n]*$",
  _FLAGS,
)

# Assistant identity is tenant-configurable, so matching a hard-coded name
# (such as ``aira``) would leave every other tenant unprotected.  ``(You)`` is
# the stable, bridge-owned part of the serialized assistant line.
_BOT_SENDER_RE = re.compile(
  r"^[^\S\n]*[^\n:]{1,128}[^\S\n]+\(You\)[^\S\n]*:",
  _FLAGS,
)

_SYSTEM_RE = re.compile(r"^[^\S\n]*SYSTEM[^\S\n]*:", _FLAGS)


def normalize_context_candidate(input_text: str) -> str:
  """Normalize Unicode and invisible separators before pattern matching."""
  if not isinstance(input_text, str):
    return ""
  return (
    unicodedata.normalize("NFKC", input_text)
    .translate({ord(char): None for char in "\u200b\u200c\u200d\u2060\ufeff"})
    .replace("\r\n", "\n")
    .replace("\r", "\n")
  )


def detect_context_injection(input_text: str) -> ContextInjectionResult:
  """Score bridge-context spoofing signals found in untrusted message text."""
  text = normalize_context_candidate(input_text)
  signals = ContextInjectionSignals(
    human_sender=bool(_HUMAN_SENDER_RE.search(text)),
    message_header=bool(_MESSAGE_HEADER_RE.search(text)),
    internal_header=bool(_INTERNAL_HEADER_RE.search(text)),
    reply_marker=bool(_REPLY_RE.search(text)),
    bot_sender=bool(_BOT_SENDER_RE.search(text)),
    system_marker=bool(_SYSTEM_RE.search(text)),
  )

  risk_score = 0
  if signals.human_sender:
    risk_score += 100
  if signals.internal_header:
    risk_score += 100
  if signals.bot_sender:
    risk_score += 100
  if signals.system_marker:
    risk_score += 100
  if signals.message_header:
    risk_score += 50
  if signals.reply_marker:
    risk_score += 50
  if signals.message_header and signals.human_sender:
    risk_score += 50
  if signals.message_header and signals.reply_marker:
    risk_score += 50

  risk_score = min(risk_score, 100)
  return ContextInjectionResult(
    detected=risk_score >= 100,
    risk_score=risk_score,
    signals=signals,
  )
