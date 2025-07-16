import json
from websockets.legacy.server import WebSocketServerProtocol
from random import randbytes
from asyncio import wait_for, Queue, TimeoutError
from typing import Optional, Any, Dict

# Asumsi state.py memiliki definisi berikut agar Pylance tidak error
# from logging import Logger
# logger: Logger = ...
# clients: Dict[WebSocketServerProtocol, str] = {}
# pending_feedback: Dict[str, Queue] = {}
# Baris di atas hanya untuk konteks, gunakan import asli Anda
from ...state.state import logger, clients, pending_feedback


async def wait_for_response(socket: WebSocketServerProtocol, uid: str) -> Any:
    """
    Menunggu respons dengan UID spesifik yang diterima dari WebSocket.

    :param socket: Objek WebSocketServerProtocol.
    :param uid: UID yang ditunggu.
    :return: Konten data yang diterima (tipe tidak dijamin, bisa apa saja).
    """
    while True:
        data_raw = await socket.recv()
        try:
            # Pastikan data adalah string sebelum di-decode
            data: Dict[str, Any] = json.loads(data_raw)
        except (json.JSONDecodeError, TypeError):
            continue
        
        msg_uid = data.get("uid")
        token = data.get("token")
        msg_type = data.get("type")
        
        if msg_uid and token and msg_uid == uid and msg_type == "response" and token == clients.get(socket):
            return data.get("content")


async def send_message(
    sock: WebSocketServerProtocol, 
    target: str, 
    message: str,
    mentions: list[str] = []
) -> None:
    """
    Mengirim pesan sederhana ke target.

    :param sock: Objek WebSocketServerProtocol.
    :param target: JID target (Grup atau User).
    :param message: Isi pesan.
    :param mentions: (Opsional) JID partisipan untuk di-mention (hanya untuk grup).
    """
    logger.info(f"Sending message: {message}")
    payload : dict[str, str|list[str]]= {"type": "simpleChat", "target": target, "message": message, "mentions": mentions}
    await sock.send(json.dumps(payload))


async def send_message_and_get_key(
    sock: WebSocketServerProtocol, 
    target: str, 
    message: str, 
    mentions: list[str]= [], 
    timeout: int = 10
) -> Optional[str]:
    """
    Mengirim pesan dan mendapatkan ID dari pesan tersebut.

    :param sock: Objek WebSocketServerProtocol.
    :param target: JID target (Grup atau User).
    :param message: Isi pesan.
    :param mentions: (Opsional) JID partisipan untuk di-mention.
    :param timeout: Batas waktu menunggu respons (detik).
    :return: ID dari pesan sebagai string, atau None jika gagal.
    """
    logger.debug("Waiting for response from client for send_message_and_get_key")
    uid = randbytes(5).hex()
    logger.debug(f"Generated UID: {uid}")
    
    queue: Queue[Dict[str, Any]] = Queue()
    pending_feedback[uid] = queue
    
    payload : dict[str,str|list[str]]= {
        "type": "chatAndGetInfo", 
        "uid": uid, 
        "target": target, 
        "message": message, 
        "mentions": mentions
    }
    await sock.send(json.dumps(payload))
    
    try:
        message_info = await wait_for(queue.get(), timeout=timeout)
        logger.debug(f"Received message key for UID: {uid}")
        
        content: Optional[Dict[str, Any]] = message_info.get("content")
        if content:
            key: Optional[Dict[str, Any]] = content.get('key')
            if key:
                message_id = key.get('id')
                if message_id:
                    logger.debug(f"Message key: {json.dumps(key, indent=2)}")
                    return message_id
        
        logger.warning(f"Message ID not found in response for UID: {uid}")
        return None
        
    except TimeoutError:
        logger.warning(f"Timeout waiting for feedback for UID: {uid}")
        return None
    finally:
        pending_feedback.pop(uid, None)
        logger.debug(f"Removed pending feedback for UID: {uid}")


async def tag_everyone(sock: WebSocketServerProtocol, target: str) -> None:
    """
    Mention semua anggota di dalam grup.

    :param sock: Objek WebSocketServerProtocol.
    :param target: JID grup (harus diakhiri dengan @g.us).
    """
    if target.endswith("@g.us"):
        logger.info(f"Tagging everyone in group: {target}")
        await sock.send(json.dumps({"type": "tagEveryone", "target": target}))
    else:
        logger.error("Tagging everyone is only supported for groups (@g.us).")


async def edit_message(sock: WebSocketServerProtocol, message: str, key: Dict[str, Any]) -> None:
    """
    Mengedit pesan yang sudah terkirim.

    :param sock: Objek WebSocketServerProtocol.
    :param message: Teks pesan baru.
    :param key: Objek kunci dari pesan yang akan diedit.
    """
    await sock.send(json.dumps({"type": "editMessage", "message": message, "key": key}))


async def send_button_message(sock: WebSocketServerProtocol, target: str, quoted_message: Dict[str, Any]) -> None:
    """
    Mengirim pesan dengan tombol.

    :param sock: Objek WebSocketServerProtocol.
    :param target: JID target.
    :param quoted_message: Objek pesan yang akan di-quote (format JSON/dict).
    """
    payload : dict[str,str|dict[str,str]]= {"type": "sendButton", "target": target, "quoted": quoted_message}
    await sock.send(json.dumps(payload))