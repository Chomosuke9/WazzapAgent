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

class CacheMessage {
  constructor(limit) {
    this.limit = limit;
    this.cache = new Map();
    for (let i = 0; i < this.limit; i++) {
        this.cache.set(Symbol(), "");
    }
  }
  set(id, value) {
    this.cache.set(id, value);
    this.cache.delete(this.cache.keys().next().value);
  }

  get(id) {
    return this.cache.get(id);
  }
}

export {getGroupCache, setGroupCache, CacheMessage}
