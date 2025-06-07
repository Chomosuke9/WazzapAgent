import {startWASocket} from "../../../whatsapp_bot/bot/bot.js"
import {token, createWebSocket} from "../client.js"
import {data} from "./process_data.js";
import crypto from 'crypto';

// sometimes you will get crypto error, to prevent this error simply add this to make it work
try {
    global.crypto = crypto;
} catch (e) {}



const { socket} = createWebSocket((msg) => {
  console.log('Received notification: ', msg);
});

const WASocket = startWASocket()

// TODO: add disconnect handler

WASocket.getSocket().ev.on("messages.upsert", async (msg) => {
    // check if the message is not from you and make sure the message is not error
    if (msg.messages[0].message && !msg.messages[0].key.fromMe) {
        socket.send(data({token: token, type: "chat", content: msg}))
    }
    })
