import {makeWASocket, useMultiFileAuthState} from 'baileys'
import {getGroupCache, setGroupCache} from '../utils/caching.js'
import pino from "pino";
import dotenv from 'dotenv';
import { resolve } from 'path';
dotenv.config({
  path: resolve('.env')
});

const { state, saveCreds } = await useMultiFileAuthState(process.env.AUTH_STATE_FILE);

    function startWASocket() {
        const sock = makeWASocket({
            auth: state, // auth state of your choosing
            syncFullHistory: false,
            shouldSyncHistoryMessages: false,
            cachedGroupMetadata: async (jid) => getGroupCache(jid, sock),
            logger: pino({ level: 'silent' })
        })
            // this code will update group metadata
            sock.ev.on("group-participants.update", async (msg) => {
                let metadata = await sock.groupMetadata(msg.id)
                await setGroupCache(msg.id, metadata)
            })

            sock.ev.on("creds.update", saveCreds);

        return sock
    }

    export {startWASocket}
