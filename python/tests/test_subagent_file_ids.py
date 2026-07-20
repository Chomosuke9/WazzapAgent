"""Regression tests for the ``<files_in_chat>`` lookup table that tells LLM2
which contextMsgId actually HOLDS a file for ``execute_subtask``.

Background: the model reliably decides *to* delegate, but it tended to pass the
latest request/mention message's ID to ``context_msg_ids`` instead of the
message that contains the file. The resolver then found no attachment and the
sub-agent silently received nothing. ``_files_for_subagent_block`` removes that
inference by listing the exact ``[#NNNNNN] -> file`` mapping.
"""
from bridge.history import WhatsAppMessage
from bridge.llm.prompt import _files_for_subagent_block


def _msg(cid, **kw):
  return WhatsAppMessage(timestamp_ms=0, context_msg_id=cid, **kw)


def test_lists_only_messages_that_hold_a_file():
  # Mirrors the real failure: document at #000196, request at #000197, a
  # mention at #000199 that only QUOTES the doc (quoted_media, not its own).
  hist = [
    _msg("000196", sender="Agus", sender_ref="29dry6", media="document", text="laporan.pdf"),
    _msg("000197", sender="Agus", sender_ref="29dry6", text="Kirim balik dokumen tadi"),
    _msg("000199", sender="Agus", sender_ref="29dry6", text="@Vivy (bot)",
         quoted_message_id="000197", quoted_media="document"),
  ]
  block = _files_for_subagent_block(hist)
  assert block is not None
  assert "[#000196]" in block          # the file-bearing message is listed
  assert "[#000197]" not in block      # the request message is NOT listed
  assert "[#000199]" not in block      # a REPLYING-TO-only message is NOT listed
  assert "laporan.pdf" in block        # caption/filename surfaced for disambiguation


def test_returns_none_when_no_attachable_files():
  hist = [_msg("000200", sender="A", sender_ref="a", text="hello")]
  assert _files_for_subagent_block(hist) is None


def test_stickers_are_excluded_as_noise():
  hist = [_msg("000201", sender="A", sender_ref="a", media="sticker", text="<media:sticker=thumbs_up>")]
  assert _files_for_subagent_block(hist) is None


def test_dedupes_and_includes_assistant_files():
  hist = [
    _msg("000010", sender="A", sender_ref="a", media="image"),
    _msg("000010", sender="A", sender_ref="a", media="image"),  # duplicate ID
    _msg("000011", sender="bot", sender_ref="bot", media="document", text="out.pdf", role="assistant"),
  ]
  block = _files_for_subagent_block(hist)
  assert block is not None
  assert block.count("[#000010]") == 1   # deduped
  assert "[#000011]" in block            # assistant-sent file included (for revisions)


def test_lists_files_from_current_merged_burst_payload():
  block = _files_for_subagent_block([], current_payload={
    "chatId": "c@g.us",
    "senderName": "Agus",
    "contextMsgId": "000202",
    "attachments": [
      {
        "kind": "document",
        "fileName": "current.pdf",
        "contextMsgId": "000201",
      },
    ],
  })
  assert block is not None
  assert "[#000201]" in block
  assert "current.pdf" in block
  assert "[#000202]" not in block
