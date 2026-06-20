"""Feature 8 (lazy media): the bridge downloads visual attachments ON DEMAND
via the download_media action; nothing is fetched when there's no visual need."""
import asyncio
import json

import pytest

from wasocket import protocol
from bridge.media import materialize_visual_media, materialize_media_for_subagent


class FakeSock:
    def __init__(self, result=None, raises=None):
        self.calls = []
        self._result = result
        self._raises = raises

    async def download_media(self, chat_id, *, context_msg_id=None, message_id=None):
        self.calls.append({"chat_id": chat_id, "context_msg_id": context_msg_id, "message_id": message_id})
        if self._raises is not None:
            raise self._raises
        return self._result


def test_download_media_action_encodes_to_wire():
    frame = protocol.DownloadMediaAction(request_id="dl-1", chat_id="c@g.us", context_msg_id="000125")
    wire = json.loads(protocol.encode(frame))
    assert wire["type"] == "download_media"
    assert wire["payload"]["chatId"] == "c@g.us"
    assert wire["payload"]["contextMsgId"] == "000125"


def test_materialize_downloads_pending_image_and_stores_path():
    payload = {
        "chatId": "c@g.us",
        "contextMsgId": "000125",
        "messageId": "wamid-1",
        "attachments": [{"kind": "image", "mime": "image/jpeg", "path": None, "pending": True}],
    }
    media_paths = {}
    sock = FakeSock(result={"path": "/tmp/wamid-1_image.jpg", "mime": "image/jpeg", "kind": "image"})
    asyncio.run(materialize_visual_media(sock, payload, media_paths))

    assert payload["attachments"][0]["path"] == "/tmp/wamid-1_image.jpg"
    assert len(sock.calls) == 1
    # path is re-stored for quoted reuse
    assert media_paths.get("c@g.us", {}).get("000125")


def test_materialize_skips_document_with_thumbnail_no_download():
    payload = {
        "chatId": "c@g.us",
        "contextMsgId": "000130",
        "messageId": "wamid-2",
        "attachments": [{"kind": "document", "jpegThumbnail": "QQ==", "path": None}],
    }
    sock = FakeSock(result={"path": "/should/not/be/used"})
    asyncio.run(materialize_visual_media(sock, payload, {}))
    assert sock.calls == [], "documents with a thumbnail are not downloaded"
    assert payload["attachments"][0]["path"] is None


def test_materialize_graceful_when_download_fails():
    payload = {
        "chatId": "c@g.us",
        "contextMsgId": "000140",
        "messageId": "gone",
        "attachments": [{"kind": "image", "path": None}],
    }
    sock = FakeSock(raises=RuntimeError("not_found"))
    asyncio.run(materialize_visual_media(sock, payload, {}))
    assert payload["attachments"][0]["path"] is None  # stays unset, no crash


def test_materialize_noop_when_already_downloaded():
    payload = {
        "chatId": "c@g.us",
        "contextMsgId": "000150",
        "attachments": [{"kind": "image", "path": "/already/here.jpg"}],
    }
    sock = FakeSock(result={"path": "/new.jpg"})
    asyncio.run(materialize_visual_media(sock, payload, {}))
    assert sock.calls == [], "no download when path already present"
    assert payload["attachments"][0]["path"] == "/already/here.jpg"


# --- materialize_media_for_subagent (sub-agent input fix) ---


def test_subagent_materialize_downloads_document(tmp_path):
    """A document referenced by execute_subtask must be downloaded on demand
    even though materialize_visual_media skips non-visual kinds."""
    doc = tmp_path / "report.pdf"
    doc.write_bytes(b"%PDF-1.4 fake")
    media_paths = {}
    sock = FakeSock(result={
        "path": str(doc), "mime": "application/pdf",
        "kind": "document", "fileName": "report.pdf",
    })
    asyncio.run(
        materialize_media_for_subagent(sock, "c@g.us", ["000200"], media_paths)
    )
    assert len(sock.calls) == 1
    assert sock.calls[0]["context_msg_id"] == "000200"
    stored = media_paths.get("c@g.us", {}).get("000200")
    assert stored and stored[0]["path"] == str(doc)
    assert stored[0]["kind"] == "document"


def test_subagent_materialize_skips_already_on_disk(tmp_path):
    """Already-materialized media is not re-downloaded."""
    doc = tmp_path / "already.docx"
    doc.write_bytes(b"PK\x03\x04")
    media_paths = {"c@g.us": {"000210": [{"path": str(doc), "kind": "document"}]}}
    sock = FakeSock(result={"path": "/should/not/be/used"})
    asyncio.run(
        materialize_media_for_subagent(sock, "c@g.us", ["000210"], media_paths)
    )
    assert sock.calls == [], "no download when a real file is already recorded"


def test_subagent_materialize_graceful_on_failure():
    """A download failure leaves the ctx_id unresolved without crashing."""
    media_paths = {}
    sock = FakeSock(raises=RuntimeError("proto evicted"))
    asyncio.run(
        materialize_media_for_subagent(sock, "c@g.us", ["000220"], media_paths)
    )
    assert media_paths.get("c@g.us", {}).get("000220") is None


def test_subagent_materialize_noop_without_sock_or_ids():
    media_paths = {}
    asyncio.run(materialize_media_for_subagent(None, "c@g.us", ["x"], media_paths))
    asyncio.run(materialize_media_for_subagent(FakeSock(), "c@g.us", [], media_paths))
    assert media_paths == {}


def test_subagent_materialize_skips_text_only_ctx_from_history(tmp_path):
    """Request-1 regression: a ctx_id that history knows is text-only (no
    ``media``) is NOT downloaded, so the gateway never replies
    'unsupported media type' and no misleading 'download failed' log appears.
    A media-bearing ctx_id in the same call is still downloaded."""
    from collections import deque
    from bridge.history import WhatsAppMessage

    doc = tmp_path / "report.pdf"
    doc.write_bytes(b"%PDF-1.4 fake")
    history = deque([
        WhatsAppMessage(timestamp_ms=0, sender="u", context_msg_id="000002",
                        text="please summarise the file", media=None),
        WhatsAppMessage(timestamp_ms=0, sender="u", context_msg_id="000003",
                        text="see attached", media="document"),
    ])
    media_paths = {}
    sock = FakeSock(result={
        "path": str(doc), "mime": "application/pdf",
        "kind": "document", "fileName": "report.pdf",
    })
    asyncio.run(
        materialize_media_for_subagent(
            sock, "c@g.us", ["000002", "000003"], media_paths, history
        )
    )
    # Only the document (000003) is downloaded; text-only 000002 is skipped.
    assert [c["context_msg_id"] for c in sock.calls] == ["000003"]
    assert media_paths.get("c@g.us", {}).get("000003")
    assert media_paths.get("c@g.us", {}).get("000002") is None


def test_subagent_materialize_attempts_ctx_absent_from_history(tmp_path):
    """A ctx_id NOT present in history (e.g. evicted from the bounded deque)
    stays eligible for a download attempt — only ctx_ids history positively
    knows are text-only are skipped."""
    from collections import deque
    from bridge.history import WhatsAppMessage

    doc = tmp_path / "old.pdf"
    doc.write_bytes(b"%PDF-1.4 fake")
    history = deque([
        WhatsAppMessage(timestamp_ms=0, sender="u", context_msg_id="000009",
                        text="unrelated text", media=None),
    ])
    media_paths = {}
    sock = FakeSock(result={
        "path": str(doc), "mime": "application/pdf",
        "kind": "document", "fileName": "old.pdf",
    })
    asyncio.run(
        materialize_media_for_subagent(
            sock, "c@g.us", ["000500"], media_paths, history
        )
    )
    assert [c["context_msg_id"] for c in sock.calls] == ["000500"]
    assert media_paths.get("c@g.us", {}).get("000500")
