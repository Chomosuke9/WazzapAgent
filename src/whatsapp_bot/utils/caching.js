import NodeCache from "node-cache";

const groupCache = new NodeCache({})

async function getGroupCache(jid, sock) {
  let cache = groupCache.get(jid)
  if (cache) return cache
  else{
    cache = await sock.groupMetadata(jid)
    groupCache.set(jid, cache)
    return cache
  }
}

async function setGroupCache(jid, metadata) {
  groupCache.set(jid, metadata)
}
export {getGroupCache, setGroupCache}