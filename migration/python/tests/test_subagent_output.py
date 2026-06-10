"""Tests for sub-agent output staging, kind detection, and gateway dispatch."""
from __future__ import annotations

import asyncio
import base64
import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bridge.subagent.output
from bridge.subagent.output import (
  MAX_FILE_SIZE_BYTES,
  StagedFile,
  SkippedFile,
  _is_animated_webp,
  cleanup_input_staging,
  detect_kind,
  format_file_list,
  stage_input_files,
  stage_output_files,
)
from bridge.messaging.gateway import send_attachment
import bridge.subagent.client
from bridge.subagent.client import SubAgentClient


# ---------------------------------------------------------------------------
# detect_kind
# ---------------------------------------------------------------------------

class TestDetectKind:
  def test_image_jpeg(self):
    kind, mime = detect_kind("/tmp/foo.jpg")
    assert kind == "image"
    assert mime == "image/jpeg"

  def test_image_png(self):
    kind, _ = detect_kind("/tmp/foo.png")
    assert kind == "image"

  def test_video_mp4(self):
    kind, mime = detect_kind("/tmp/foo.mp4")
    assert kind == "video"
    assert mime == "video/mp4"

  def test_audio_mp3(self):
    kind, _ = detect_kind("/tmp/foo.mp3")
    assert kind == "audio"

  def test_pdf_is_document(self):
    kind, mime = detect_kind("/tmp/foo.pdf")
    assert kind == "document"
    assert mime == "application/pdf"

  def test_csv_is_document(self):
    kind, _ = detect_kind("/tmp/foo.csv")
    assert kind == "document"

  def test_unknown_extension_falls_back_to_document(self):
    kind, mime = detect_kind("/tmp/foo.unknownext")
    assert kind == "document"
    assert mime == "application/octet-stream"

  def test_no_extension_falls_back_to_document(self):
    kind, mime = detect_kind("/tmp/somefile")
    assert kind == "document"
    assert mime == "application/octet-stream"

  def test_webp_is_image_not_sticker(self):
    # Bare .webp from a sub-agent isn't a real WhatsApp sticker (no EXIF), so
    # we send it as an image rather than as a sticker.
    kind, _ = detect_kind("/tmp/foo.webp")
    assert kind == "image"

  # ---- Magic-byte sniffing for files whose extension is missing/wrong ----
  # Without sniffing, WhatsApp clients fall back to rendering unknown
  # streams as PDF, which produces unopenable messages.

  def test_sniffs_pdf_when_extension_is_missing(self, tmp_path):
    p = tmp_path / "no_extension_pdf"
    p.write_bytes(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    kind, mime = detect_kind(str(p))
    assert kind == "document"
    assert mime == "application/pdf"

  def test_sniffs_png_when_extension_is_misleading(self, tmp_path):
    # File is a real PNG but the name lies — extension says .pdf.
    p = tmp_path / "lying.pdf"
    p.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 24)
    kind, mime = detect_kind(str(p))
    # Extension wins when it produces a known mime, so this still says PDF.
    # (Sniffing only fires when the extension fails to give a usable mime.)
    assert kind == "document"
    assert mime == "application/pdf"

  def test_sniffs_jpeg_for_extensionless_image(self, tmp_path):
    p = tmp_path / "photo"
    p.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 12)
    kind, mime = detect_kind(str(p))
    assert kind == "image"
    assert mime == "image/jpeg"

  def test_sniffs_zip_for_extensionless_office_doc(self, tmp_path):
    # PK\x03\x04 is the magic for ZIP, which covers DOCX/XLSX/PPTX/EPUB.
    p = tmp_path / "report"
    p.write_bytes(b"PK\x03\x04" + b"\x00" * 20)
    kind, mime = detect_kind(str(p))
    assert kind == "document"
    assert mime == "application/zip"

  def test_sniffs_mp4_for_extensionless_video(self, tmp_path):
    p = tmp_path / "movie"
    # MP4 container: 4 bytes box size, then 'ftyp', then a brand.
    p.write_bytes(b"\x00\x00\x00\x20ftypisom" + b"\x00" * 8)
    kind, mime = detect_kind(str(p))
    assert kind == "video"
    assert mime == "video/mp4"

  def test_octet_stream_is_overridden_by_sniff(self, tmp_path):
    # Even when ``mimetypes`` would say octet-stream, sniffing should win.
    p = tmp_path / "data.bin"
    p.write_bytes(b"%PDF-1.4\n")
    kind, mime = detect_kind(str(p))
    assert kind == "document"
    assert mime == "application/pdf"

  def test_unknown_content_with_no_extension_still_falls_back(self, tmp_path):
    p = tmp_path / "unknown_blob"
    p.write_bytes(b"\x00\x01\x02\x03\x04\x05\x06\x07")
    kind, mime = detect_kind(str(p))
    assert kind == "document"
    assert mime == "application/octet-stream"

  def test_docx_extension_yields_office_mime(self):
    kind, mime = detect_kind("/tmp/report.docx")
    assert kind == "document"
    assert "wordprocessingml" in mime

  # ---- WhatsApp format whitelist: unsupported formats become document ----

  def test_webm_is_document(self):
    kind, _ = detect_kind("/tmp/foo.webm")
    assert kind == "document"

  def test_mkv_is_document(self):
    kind, _ = detect_kind("/tmp/foo.mkv")
    assert kind == "document"

  def test_avi_is_document(self):
    kind, _ = detect_kind("/tmp/foo.avi")
    assert kind == "document"

  def test_gif_is_document(self):
    kind, _ = detect_kind("/tmp/foo.gif")
    assert kind == "document"

  def test_wav_is_document(self):
    kind, _ = detect_kind("/tmp/foo.wav")
    assert kind == "document"

  def test_flac_is_document(self):
    kind, _ = detect_kind("/tmp/foo.flac")
    assert kind == "document"

  def test_static_webp_is_image(self, tmp_path):
    # Static WebP: RIFF....WEBPVP8 (no VP8X chunk)
    p = tmp_path / "static.webp"
    p.write_bytes(b'RIFF' + b'\x00' * 4 + b'WEBPVP8 ' + b'\x00' * 20)
    kind, _ = detect_kind(str(p))
    assert kind == "image"

  def test_animated_webp_is_document(self, tmp_path):
    # Animated WebP: VP8X chunk with animation bit (bit 1 of flags byte at offset 20)
    header = bytearray(21)
    header[0:4] = b'RIFF'
    header[8:12] = b'WEBP'
    header[12:16] = b'VP8X'
    header[20] = 0x02  # animation bit set
    p = tmp_path / "animated.webp"
    p.write_bytes(bytes(header) + b'\x00' * 20)
    kind, _ = detect_kind(str(p))
    assert kind == "document"

  def test_mp4_is_still_video(self):
    kind, mime = detect_kind("/tmp/foo.mp4")
    assert kind == "video"
    assert mime == "video/mp4"

  def test_mp3_is_still_audio(self):
    kind, _ = detect_kind("/tmp/foo.mp3")
    assert kind == "audio"

  def test_m4a_is_still_audio(self):
    kind, _ = detect_kind("/tmp/foo.m4a")
    assert kind == "audio"

  def test_ogg_is_still_audio(self):
    kind, _ = detect_kind("/tmp/foo.ogg")
    assert kind == "audio"

  def test_png_is_still_image(self):
    kind, _ = detect_kind("/tmp/foo.png")
    assert kind == "image"

  def test_jpg_is_still_image(self):
    kind, _ = detect_kind("/tmp/foo.jpg")
    assert kind == "image"


# ---------------------------------------------------------------------------
# _is_animated_webp
# ---------------------------------------------------------------------------

class TestIsAnimatedWebp:
  def test_animated_webp_detected(self, tmp_path):
    header = bytearray(21)
    header[0:4] = b'RIFF'
    header[8:12] = b'WEBP'
    header[12:16] = b'VP8X'
    header[20] = 0x02  # animation bit
    p = tmp_path / "anim.webp"
    p.write_bytes(bytes(header) + b'\x00' * 20)
    assert _is_animated_webp(str(p)) is True

  def test_static_webp_not_detected(self, tmp_path):
    header = bytearray(21)
    header[0:4] = b'RIFF'
    header[8:12] = b'WEBP'
    header[12:16] = b'VP8X'
    header[20] = 0x00  # no animation bit
    p = tmp_path / "static.webp"
    p.write_bytes(bytes(header) + b'\x00' * 20)
    assert _is_animated_webp(str(p)) is False

  def test_non_vp8x_webp_not_animated(self, tmp_path):
    p = tmp_path / "simple.webp"
    p.write_bytes(b'RIFF' + b'\x00' * 4 + b'WEBPVP8 ' + b'\x00' * 20)
    assert _is_animated_webp(str(p)) is False

  def test_non_webp_file_returns_false(self, tmp_path):
    p = tmp_path / "notwebp.png"
    p.write_bytes(b'\x89PNG\r\n\x1a\n' + b'\x00' * 20)
    assert _is_animated_webp(str(p)) is False

  def test_missing_file_returns_false(self):
    assert _is_animated_webp("/nonexistent/file.webp") is False

  def test_too_short_file_returns_false(self, tmp_path):
    p = tmp_path / "short.webp"
    p.write_bytes(b'RIFF' + b'\x00' * 8)
    assert _is_animated_webp(str(p)) is False


# ---------------------------------------------------------------------------
# stage_output_files
# ---------------------------------------------------------------------------

class TestStageOutputFiles:
  def _make_file(self, dirpath: Path, name: str, size: int = 16) -> Path:
    p = dirpath / name
    p.write_bytes(b"x" * size)
    return p

  def test_stages_single_file(self, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    src = self._make_file(src_dir, "report.csv", size=128)
    base = tmp_path / "media"
    result = stage_output_files("sess1", [str(src)], base_dir=base)
    assert len(result.staged) == 1
    assert result.skipped == []
    f = result.staged[0]
    assert f.name == "report.csv"
    assert f.kind == "document"
    assert f.size_bytes == 128
    assert Path(f.path).exists()
    assert Path(f.path).read_bytes() == b"x" * 128
    # Staged copy is under base/sess1/, not the original location.
    assert str(base / "sess1") in f.path

  def test_stages_multiple_kinds(self, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    files = [
      self._make_file(src_dir, "a.png", 10),
      self._make_file(src_dir, "b.mp4", 20),
      self._make_file(src_dir, "c.mp3", 30),
      self._make_file(src_dir, "d.pdf", 40),
    ]
    base = tmp_path / "media"
    result = stage_output_files("s2", [str(p) for p in files], base_dir=base)
    kinds = {f.name: f.kind for f in result.staged}
    assert kinds == {
      "a.png": "image",
      "b.mp4": "video",
      "c.mp3": "audio",
      "d.pdf": "document",
    }
    assert result.skipped == []

  def test_skips_missing_file(self, tmp_path):
    base = tmp_path / "media"
    result = stage_output_files("s3", ["/nonexistent/path/to/file.txt"], base_dir=base)
    assert result.staged == []
    assert len(result.skipped) == 1
    assert "not found" in result.skipped[0].reason

  def test_skips_oversized_file(self, tmp_path, monkeypatch):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    big = self._make_file(src_dir, "big.bin", size=2048)
    # Lower the cap to something the file exceeds without writing 200MB to disk.
    monkeypatch.setattr("bridge.subagent.output.MAX_FILE_SIZE_BYTES", 1024)
    base = tmp_path / "media"
    result = stage_output_files("s4", [str(big)], base_dir=base)
    assert result.staged == []
    assert len(result.skipped) == 1
    assert "too large" in result.skipped[0].reason

  def test_skips_directory(self, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    nested = src_dir / "nested"
    nested.mkdir()
    base = tmp_path / "media"
    result = stage_output_files("s5", [str(nested)], base_dir=base)
    assert result.staged == []
    assert len(result.skipped) == 1
    assert "regular file" in result.skipped[0].reason

  def test_handles_empty_input(self, tmp_path):
    base = tmp_path / "media"
    result = stage_output_files("s6", [], base_dir=base)
    assert result.staged == []
    assert result.skipped == []

  def test_handles_empty_session_id(self, tmp_path):
    src = self._make_file(tmp_path, "x.txt")
    base = tmp_path / "media"
    result = stage_output_files("", [str(src)], base_dir=base)
    assert result.staged == []
    assert result.skipped == []

  def test_resolves_collision_in_basenames(self, tmp_path):
    a_dir = tmp_path / "a"
    b_dir = tmp_path / "b"
    a_dir.mkdir()
    b_dir.mkdir()
    a_file = a_dir / "report.csv"
    b_file = b_dir / "report.csv"
    a_file.write_text("first")
    b_file.write_text("second")
    base = tmp_path / "media"
    result = stage_output_files("s7", [str(a_file), str(b_file)], base_dir=base)
    assert len(result.staged) == 2
    names = sorted(f.name for f in result.staged)
    assert names == ["report.csv", "report_1.csv"]
    # Originals must still be readable as separate copies.
    contents = sorted(Path(f.path).read_text() for f in result.staged)
    assert contents == ["first", "second"]

  def test_partial_failure_does_not_abort_batch(self, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    good = self._make_file(src_dir, "ok.txt")
    base = tmp_path / "media"
    result = stage_output_files(
      "s8",
      [str(good), "/does/not/exist.bin"],
      base_dir=base,
    )
    assert len(result.staged) == 1
    assert result.staged[0].name == "ok.txt"
    assert len(result.skipped) == 1

  def test_default_size_cap_is_200mb(self):
    assert MAX_FILE_SIZE_BYTES == 200 * 1024 * 1024


# ---------------------------------------------------------------------------
# stage_input_files / cleanup_input_staging
# ---------------------------------------------------------------------------

class TestStageInputFiles:
  def _make_file(self, dirpath: Path, name: str, size: int = 16) -> Path:
    p = dirpath / name
    p.write_bytes(b"y" * size)
    return p

  def test_copies_files_into_session_subdir(self, tmp_path):
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    a = self._make_file(src_dir, "a.txt", size=8)
    b = self._make_file(src_dir, "b.bin", size=12)
    base = tmp_path / "exchange"
    paths = stage_input_files("sess1", [str(a), str(b)], base_dir=base)
    assert len(paths) == 2
    for p in paths:
      assert Path(p).exists()
      assert (base / "sess1") in Path(p).parents
    # Names preserved
    names = sorted(Path(p).name for p in paths)
    assert names == ["a.txt", "b.bin"]
    # Contents preserved
    assert Path(paths[0]).read_bytes() == b"y" * 8
    assert Path(paths[1]).read_bytes() == b"y" * 12

  def test_skips_missing_files(self, tmp_path):
    paths = stage_input_files(
      "s2", ["/nonexistent/foo.txt"], base_dir=tmp_path / "x"
    )
    assert paths == []

  def test_skips_directories(self, tmp_path):
    sub = tmp_path / "src" / "nested"
    sub.mkdir(parents=True)
    paths = stage_input_files("s3", [str(sub)], base_dir=tmp_path / "x")
    assert paths == []

  def test_skips_oversized(self, tmp_path, monkeypatch):
    src = self._make_file(tmp_path, "big.bin", size=4096)
    monkeypatch.setattr("bridge.subagent.output.MAX_FILE_SIZE_BYTES", 1024)
    paths = stage_input_files("s4", [str(src)], base_dir=tmp_path / "x")
    assert paths == []

  def test_handles_empty_inputs(self, tmp_path):
    assert stage_input_files("s5", [], base_dir=tmp_path) == []

  def test_handles_empty_session_id(self, tmp_path):
    src = self._make_file(tmp_path, "x.txt")
    assert stage_input_files("", [str(src)], base_dir=tmp_path / "x") == []

  def test_resolves_basename_collisions(self, tmp_path):
    a_dir = tmp_path / "a"
    b_dir = tmp_path / "b"
    a_dir.mkdir()
    b_dir.mkdir()
    a_file = a_dir / "img.jpg"
    b_file = b_dir / "img.jpg"
    a_file.write_bytes(b"first")
    b_file.write_bytes(b"second")
    base = tmp_path / "exchange"
    paths = stage_input_files("s6", [str(a_file), str(b_file)], base_dir=base)
    assert len(paths) == 2
    names = {Path(p).name for p in paths}
    assert "img.jpg" in names
    # Second file got renamed to avoid clobbering the first
    assert any(n.startswith("img_") and n.endswith(".jpg") for n in names)

  def test_returns_absolute_resolved_paths(self, tmp_path):
    src = self._make_file(tmp_path, "x.txt")
    paths = stage_input_files("s7", [str(src)], base_dir=tmp_path / "exchange")
    assert len(paths) == 1
    assert os.path.isabs(paths[0])
    # Path matches a real file
    assert os.path.isfile(paths[0])


class TestCleanupInputStaging:
  def test_removes_session_dir(self, tmp_path):
    base = tmp_path / "exchange"
    src = tmp_path / "x.txt"
    src.write_text("hi")
    paths = stage_input_files("sess1", [str(src)], base_dir=base)
    assert paths and Path(paths[0]).exists()
    cleanup_input_staging("sess1", base_dir=base)
    assert not (base / "sess1").exists()

  def test_no_op_for_missing_dir(self, tmp_path):
    # Should not raise
    cleanup_input_staging("never_existed", base_dir=tmp_path / "exchange")

  def test_no_op_for_empty_session_id(self, tmp_path):
    cleanup_input_staging("", base_dir=tmp_path)


# ---------------------------------------------------------------------------
# format_file_list
# ---------------------------------------------------------------------------

class TestFormatFileList:
  def test_empty_returns_empty_string(self):
    assert format_file_list([], []) == ""

  def test_only_staged(self):
    staged = [
      StagedFile(path="/x/a.png", name="a.png", size_bytes=2048, mime="image/png", kind="image"),
    ]
    text = format_file_list(staged, [])
    assert "Output files attached (1):" in text
    assert "a.png" in text
    assert "image" in text

  def test_with_skipped(self):
    skipped = [SkippedFile(source_path="/x/big.bin", name="big.bin", reason="file too large (250.0 MB > 200 MB)")]
    text = format_file_list([], skipped)
    assert "Files skipped (1):" in text
    assert "big.bin" in text
    assert "too large" in text


# ---------------------------------------------------------------------------
# send_attachment gateway helper
# ---------------------------------------------------------------------------

class FakeWS:
  """Stand-in for a :class:`wasocket.WaSocket`.

  Step 28 moved the transport seam: the gateway ``send_*`` helpers now hand
  their pre-serialised JSON frame to ``ws._transport.send`` (the WaSocket's
  transport) instead of ``ws.send``. This fake mirrors that surface — the
  recorded frames (``self.sent``) are the exact same JSON strings as before.
  """

  class _Transport:
    def __init__(self, outer: "FakeWS") -> None:
      self._outer = outer

    async def send(self, payload: str) -> None:
      self._outer.sent.append(payload)

  def __init__(self):
    self.sent: list[str] = []
    self._transport = FakeWS._Transport(self)

  async def send(self, payload: str) -> None:
    # Back-compat: some call paths may still target ``ws.send`` directly.
    self.sent.append(payload)


class TestSendAttachment:
  def test_sends_send_message_payload_with_attachments(self):
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="123@s.whatsapp.net",
      attachment_path="/data/media/subagent_out/sess/file.pdf",
      kind="document",
      request_id="req-1",
      file_name="file.pdf",
    ))
    assert len(ws.sent) == 1
    msg = json.loads(ws.sent[0])
    assert msg["type"] == "send_message"
    payload = msg["payload"]
    assert payload["chatId"] == "123@s.whatsapp.net"
    assert payload["requestId"] == "req-1"
    assert "text" not in payload
    assert payload["attachments"] == [{
      "kind": "document",
      "path": "/data/media/subagent_out/sess/file.pdf",
      "fileName": "file.pdf",
    }]

  def test_includes_reply_to_when_provided(self):
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="g@g.us",
      attachment_path="/data/media/foo.png",
      kind="image",
      request_id="req-2",
      reply_to="000125",
    ))
    msg = json.loads(ws.sent[0])
    assert msg["payload"]["replyTo"] == "000125"

  def test_includes_caption_when_provided(self):
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="g@g.us",
      attachment_path="/data/media/foo.png",
      kind="image",
      request_id="req-3",
      caption="hello",
    ))
    att = json.loads(ws.sent[0])["payload"]["attachments"][0]
    assert att["caption"] == "hello"

  def test_forwards_mime_to_node(self):
    # Without an explicit mimetype, Baileys treats unknown documents as PDFs
    # and produces unopenable WhatsApp messages. The bridge has to forward
    # the value detect_kind() resolved.
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="g@g.us",
      attachment_path="/data/media/foo.docx",
      kind="document",
      request_id="req-mime",
      file_name="foo.docx",
      mime="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ))
    att = json.loads(ws.sent[0])["payload"]["attachments"][0]
    assert att["mime"] == (
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )

  def test_omits_mime_field_when_not_provided(self):
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="g@g.us",
      attachment_path="/data/media/foo.png",
      kind="image",
      request_id="req-nomime",
    ))
    att = json.loads(ws.sent[0])["payload"]["attachments"][0]
    assert "mime" not in att

  def test_noop_when_path_missing(self):
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="g@g.us",
      attachment_path="",
      kind="image",
      request_id="req-4",
    ))
    assert ws.sent == []

  def test_noop_when_kind_missing(self):
    ws = FakeWS()
    asyncio.run(send_attachment(
      ws,
      chat_id="g@g.us",
      attachment_path="/x.png",
      kind="",
      request_id="req-5",
    ))
    assert ws.sent == []


# ---------------------------------------------------------------------------
# TestStageOutputFilesFromContent
# ---------------------------------------------------------------------------

class TestStageOutputFilesFromContent:
  def test_uses_files_content_to_write_file(self, tmp_path):
    pdf_bytes = b'%PDF-1.4'
    encoded = base64.b64encode(pdf_bytes).decode("ascii")
    result = stage_output_files(
      "sess_b64",
      [],
      files_content=[{"name": "report.pdf", "content_base64": encoded, "mime": "application/pdf"}],
      base_dir=tmp_path,
    )
    staged = result.staged
    assert len(staged) == 1
    assert staged[0].name == "report.pdf"
    assert staged[0].kind == "document"
    assert staged[0].size_bytes == len(pdf_bytes)
    assert Path(staged[0].path).exists()
    assert Path(staged[0].path).read_bytes() == pdf_bytes

  def test_files_content_image_detected(self, tmp_path):
    jpeg_bytes = b'\xff\xd8\xff\xe0' + b'\x00' * 12
    encoded = base64.b64encode(jpeg_bytes).decode("ascii")
    result = stage_output_files(
      "sess_img",
      [],
      files_content=[{"name": "photo.jpg", "content_base64": encoded}],
      base_dir=tmp_path,
    )
    staged = result.staged
    assert len(staged) == 1
    assert staged[0].kind == "image"
    assert staged[0].mime == "image/jpeg"

  def test_empty_files_content_falls_back_to_raw_paths(self, tmp_path):
    real_file = tmp_path / "source" / "data.txt"
    real_file.parent.mkdir()
    real_file.write_bytes(b"hello")
    result = stage_output_files(
      "sess_fb",
      [str(real_file)],
      files_content=[],
      base_dir=tmp_path / "out",
    )
    assert len(result.staged) == 1
    assert result.staged[0].name == "data.txt"

  def test_none_files_content_falls_back_to_raw_paths(self, tmp_path):
    real_file = tmp_path / "source" / "readme.txt"
    real_file.parent.mkdir()
    real_file.write_bytes(b"world")
    result = stage_output_files(
      "sess_none",
      [str(real_file)],
      files_content=None,
      base_dir=tmp_path / "out",
    )
    assert len(result.staged) == 1
    assert result.staged[0].name == "readme.txt"

  def test_invalid_base64_is_skipped(self, tmp_path):
    result = stage_output_files(
      "sess_invalid",
      [],
      files_content=[{"name": "bad.bin", "content_base64": "not-valid-base64!!!"}],
      base_dir=tmp_path,
    )
    assert result.staged == []
    assert len(result.skipped) == 1
    assert "base64 decode failed" in result.skipped[0].reason

  def test_oversized_files_content_is_skipped(self, tmp_path, monkeypatch):
    monkeypatch.setattr("bridge.subagent.output.MAX_FILE_SIZE_BYTES", 4)
    data = b"12345678"  # 8 bytes > 4 byte limit
    encoded = base64.b64encode(data).decode("ascii")
    result = stage_output_files(
      "sess_over",
      [],
      files_content=[{"name": "big.bin", "content_base64": encoded}],
      base_dir=tmp_path,
    )
    assert result.staged == []
    assert len(result.skipped) == 1
    assert "too large" in result.skipped[0].reason

  def test_collision_handling_in_files_content(self, tmp_path):
    data1 = base64.b64encode(b"content-one").decode("ascii")
    data2 = base64.b64encode(b"content-two").decode("ascii")
    result = stage_output_files(
      "sess_coll",
      [],
      files_content=[
        {"name": "out.csv", "content_base64": data1},
        {"name": "out.csv", "content_base64": data2},
      ],
      base_dir=tmp_path,
    )
    assert len(result.staged) == 2
    names = sorted(f.name for f in result.staged)
    assert names == ["out.csv", "out_1.csv"]

  def test_oversized_content_file_falls_back_to_raw_path(self, tmp_path):
    # Scenario: files_content has one small PDF, but raw_paths has a second
    # file (different name) that was too large to inline. The second file
    # must NOT be silently dropped — it should be copied via path-copy logic.
    src_dir = tmp_path / "src"
    src_dir.mkdir()
    big_file = src_dir / "big_video.mp4"
    big_file.write_bytes(b"\x00" * 64)  # real file on disk (simulating oversized)

    pdf_bytes = b'%PDF-1.4 test'
    encoded = base64.b64encode(pdf_bytes).decode("ascii")
    result = stage_output_files(
      "sess_mixed",
      [str(big_file)],  # raw_paths contains the oversized file
      files_content=[{"name": "report.pdf", "content_base64": encoded, "mime": "application/pdf"}],
      base_dir=tmp_path / "out",
    )
    staged_names = {f.name for f in result.staged}
    # The inlined PDF must be present
    assert "report.pdf" in staged_names
    # The raw_path file (different name, not in files_content) must also be staged
    assert "big_video.mp4" in staged_names
    assert len(result.staged) == 2


# ---------------------------------------------------------------------------
# TestSubAgentClientEncodeInputFiles
# ---------------------------------------------------------------------------

class TestSubAgentClientEncodeInputFiles:
  def test_encodes_small_file(self, tmp_path):
    tmp_file = tmp_path / "hello.txt"
    tmp_file.write_bytes(b"hello world")
    client = SubAgentClient(base_url="http://localhost:9999", webhook_url="http://localhost:9999/cb")
    result = client._encode_input_files([str(tmp_file)])
    assert len(result) == 1
    assert result[0]["name"] == "hello.txt"
    assert base64.b64decode(result[0]["content_base64"]) == b"hello world"

  def test_skips_missing_file(self, tmp_path):
    client = SubAgentClient(base_url="http://localhost:9999", webhook_url="http://localhost:9999/cb")
    result = client._encode_input_files([str(tmp_path / "nonexistent.txt")])
    assert result == []

  def test_skips_oversized_file(self, tmp_path, monkeypatch):
    monkeypatch.setattr("bridge.subagent.client.SUBAGENT_MAX_INLINE_FILE_BYTES", 4)
    big_file = tmp_path / "big.bin"
    big_file.write_bytes(b"12345678")  # 8 bytes > 4 byte limit
    client = SubAgentClient(base_url="http://localhost:9999", webhook_url="http://localhost:9999/cb")
    result = client._encode_input_files([str(big_file)])
    assert result == []

  def test_returns_empty_for_empty_input(self):
    client = SubAgentClient(base_url="http://localhost:9999", webhook_url="http://localhost:9999/cb")
    assert client._encode_input_files([]) == []
