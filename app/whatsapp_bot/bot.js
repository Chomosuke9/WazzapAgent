import makeWASocket from 'baileys'
import NodeCache from 'node-cache'

// Cache group metadata
const groupCache = new NodeCache({})
async function getGroupCache(jid) {
  let cache = groupCache.get(jid)
  if (cache) return cache
  else{
    cache = await sock.groupMetadata(jid)
    groupCache.set(jid, cache)
    return cache
  }
}



const sock = makeWASocket({
  auth: {}, // auth state of your choosing,
  printQRInTerminal: true,
  syncFullHistory: false,
  shouldSyncHistoryMessages: false,
  cachedGroupMetadata: async (jid) => getGroupCache(jid)
  })

sock.ev.on("messages.upsert", async (msg) => {

});


// this code will update group metadata
sock.ev.on("group-participants.update", async (msg) => {
  let metadata = await sock.groupMetadata(msg.id)
  groupCache.set(msg.id, metadata)
})

