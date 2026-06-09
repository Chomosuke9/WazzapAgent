"""Tests for WhatsApp text formatting sanitization.

Covers :func:`bridge.messaging.format.sanitize_whatsapp_text` which converts
Markdown-style ``**bold**`` to WhatsApp-compatible ``*bold*``.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bridge.messaging.format import sanitize_whatsapp_text


class TestSanitizeDoubleAsteriskBold:
    """Core double-asterisk → single-asterisk conversion."""

    def test_simple_bold(self):
        assert sanitize_whatsapp_text("**bold**") == "*bold*"

    def test_multiple_bold(self):
        assert (
            sanitize_whatsapp_text("**bold** and **another**")
            == "*bold* and *another*"
        )

    def test_multi_word_bold(self):
        assert sanitize_whatsapp_text("**multi word bold**") == "*multi word bold*"

    def test_already_correct_single_asterisk(self):
        """Single-asterisk bold (already WhatsApp-compatible) must be left alone."""
        assert sanitize_whatsapp_text("already *correct*") == "already *correct*"

    def test_mixed_bold_and_italic(self):
        assert (
            sanitize_whatsapp_text("**bold** normal _italic_ **bold2**")
            == "*bold* normal _italic_ *bold2*"
        )

    def test_no_asterisks(self):
        assert sanitize_whatsapp_text("plain text") == "plain text"

    def test_empty_string(self):
        assert sanitize_whatsapp_text("") == ""

    def test_double_asterisk_at_line_start(self):
        assert (
            sanitize_whatsapp_text("**heading**\nsome text")
            == "*heading*\nsome text"
        )

    def test_numbered_list_with_bold(self):
        assert (
            sanitize_whatsapp_text("1. **item one**\n2. **item two**")
            == "1. *item one*\n2. *item two*"
        )

    def test_bold_surrounded_by_spaces(self):
        """Leading/trailing spaces inside ** ** should not prevent matching
        but spaces adjacent to the asterisks should be handled correctly."""
        # "** bold **" with spaces next to asterisks — the regex requires
        # the content not to start/end with spaces, so this should NOT match.
        assert sanitize_whatsapp_text("** bold **") == "** bold **"

    def test_adjacent_bold_segments(self):
        assert (
            sanitize_whatsapp_text("**a****b**")
            == "*a**b*"
        )

    def test_triple_asterisk(self):
        """***bold and italic***: the regex matches the outermost ** ** pairs,
        converting them to single * pairs. The remaining inner * on each end
        forms ** which is then convertido * **bold and italic**."""
        assert (
            sanitize_whatsapp_text("***bold and italic***")
            == "**bold and italic**"
        )

    def test_preserves_italic_underscores(self):
        """_italic_ markup must be untouched."""
        assert sanitize_whatsapp_text("_hello_") == "_hello_"

    def test_preserves_strikethrough(self):
        """~strikethrough~ markup must be untouched."""
        assert sanitize_whatsapp_text("~deleted~") == "~deleted~"

    def test_preserves_code_backticks(self):
        assert sanitize_whatsapp_text("`code`") == "`code`"

    def test_real_world_llm_output(self):
        text = "Berikut hasilnya:\n**Nama:** John\n**Umur:** 25\n**Kota:** Jakarta"
        expected = "Berikut hasilnya:\n*Nama:* John\n*Umur:* 25\n*Kota:* Jakarta"
        assert sanitize_whatsapp_text(text) == expected

    def test_nested_single_asterisk_inside_double(self):
        """**bold *and* bold** → *bold *and* bold*"""
        assert (
            sanitize_whatsapp_text("**bold *and* bold**")
            == "*bold *and* bold*"
        )

    def test_does_not_match_lone_double_asterisk(self):
        """A single ** (not a pair) should not be touched."""
        assert sanitize_whatsapp_text("this is ** unmatched") == "this is ** unmatched"

    def test_unicode_bold(self):
        assert sanitize_whatsapp_text("**こんにちは**") == "*こんにちは*"