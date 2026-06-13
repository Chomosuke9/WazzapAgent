"""Feature 8 (lazy media): the bridge downloads visual attachments ON DEMAND
via the download_media action; nothing is fetched when there's no visual need."""
import asyncio
import json

import pytest

from wasocket import protocol
from bridge.media import materialize_visual_media


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
