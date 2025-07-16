import {startWASocket} from "../../../whatsapp_bot/bot/bot.js"
import {token, createWebSocket} from "../client.js"
import {chat, notify} from "./process_data.js";
import crypto from 'crypto';
import {handleMessage} from "../../../proccess_message/handlers.js"
import QRCode from "qrcode";
import dotenv from "dotenv";
import {resolve} from "path";
import {DisconnectReason} from "baileys";
import {sleep} from "../../../utils/sleep.js";
import { cache } from "../../../state/state.js";
import { parseMessage } from "../../../proccess_message/messageParser.js";
dotenv.config({
  path: resolve('../..//.env')
});
let WASocket



// sometimes you will get crypto error, to prevent this error simply add this to make it work
try {
global.crypto = crypto;
} catch (e) {}




function startBot(socket, printQRinTerminal = true){
    WASocket = startWASocket()

    WASocket.ev.on("connection.update", (update) => {
        if (update.qr && printQRinTerminal){QRCode.toString(update.qr, { type: 'terminal', small: true}).then(console.log)}
    // TODO : add login with pairing code
        else if (update.connection === "open"){
            socket.send(notify(token, "Successfully connected to WhatsApp server."));
        } else if (update.connection === "connecting"){
            socket.send(notify(token, "Connecting to WhatsApp server."));
        } else if (update.connection === "close"){
            const lastDisconnectReason = update?.lastDisconnect?.error
            socket.send(notify(token, "Disconnected from WhatsApp server, reason: " + lastDisconnectReason));
            if (lastDisconnectReason === DisconnectReason.connectionClosed ||
                lastDisconnectReason === DisconnectReason.connectionLost ||
                lastDisconnectReason === DisconnectReason.restartRequired ||
                lastDisconnectReason === DisconnectReason.timedOut)
            {startBot(socket, printQRinTerminal);}

            else {process.exit(1)}
        }
    })


    WASocket.ev.on("messages.upsert", async (msg) => {
        // check if the message is not from you and make sure the message is not error
        if (msg.messages[0].message && !msg.messages[0].key.fromMe) {
            console.log("message received:", JSON.stringify(msg.messages[0], null, 2));
            const parsedMessage = await parseMessage(msg.messages[0]);
            socket.send(chat(token, parsedMessage))
            cache.set(msg.messages[0].key.id, msg.messages[0]);
            
            //console.log(msg)
        } else if (msg.messages[0].message && msg.messages[0].key.fromMe){
            cache.set(msg.messages[0].key.id, msg.messages[0]);
        }
    })
}


function startBridge() {
    const socket = createWebSocket((msg) => {
        console.log("message:", msg)
        handleMessage(WASocket,socket, msg)
    });
    socket.addEventListener('open', () => {
        setTimeout(() => {
            startBot(socket, true)
        }, 50);
    });
}

export {startBridge}