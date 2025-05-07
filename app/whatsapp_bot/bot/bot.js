import {makeWASocket, useMultiFileAuthState, initAuthCreds} from 'baileys'
import {getGroupCache, setGroupCache} from '../utils/caching.js'
import pino from "pino";
const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");


function startWASocket() {
    return makeWASocket({
        auth: state, // auth state of your choosing,
        printQRInTerminal: true,
        syncFullHistory: false,
        shouldSyncHistoryMessages: false,
        cachedGroupMetadata: async (jid) => getGroupCache(jid, sock),
        logger: pino({ level: 'error' })
    })
}

let sock = startWASocket()


sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
        console.log("Connected to WhatsApp!");
    }
    else if (connection === "close") {
        console.log("Connection closed. Reconnecting...");
        //sock = startWASocket()
    }
    else if (connection === "connecting") {
        console.log("Connecting...");
    }
})

sock.ev.on("messages.upsert", async (msg) => {

     console.log(msg.messages)
     const msgObj = msg.messages?.[0]?.message || {};
     const text = msgObj.conversation || msgObj.extendedTextMessage?.text || msgObj.imageMessage?.caption || null;
     if (text.slice(0,4) === "onWA") {
     let result = await sock.onWhatsApp("17822224111@s.whatsapp.net")
     console.log(result)

}})


// this code will update group metadata
sock.ev.on("group-participants.update", async (msg) => {
    let metadata = await sock.groupMetadata(msg.id)
    await setGroupCache(msg.id, metadata)
})

sock.ev.on("creds.update", saveCreds);


