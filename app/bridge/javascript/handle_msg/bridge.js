import {startWASocket} from "../../../whatsapp_bot/bot/bot.js"
import {token, createWebSocket} from "../client.js"
import {chat} from "./process_data.js";
import crypto from 'crypto';
import {handle_message} from "../../../proccess_message/handlers.js"

// sometimes you will get crypto error, to prevent this error simply add this to make it work
try {
global.crypto = crypto;
} catch (e) {}

function startBridge() {
    const {socket} = createWebSocket((msg) => {
        handle_message(WASocket,socket, msg)
    });

    const WASocket = startWASocket()

// TODO: add disconnect handler

    WASocket.ev.on("messages.upsert", async (msg) => {
        // check if the message is not from you and make sure the message is not error
        if (msg.messages[0].message && !msg.messages[0].key.fromMe) {
            socket.send(chat(token, msg))
        }
    })
}

export {startBridge}