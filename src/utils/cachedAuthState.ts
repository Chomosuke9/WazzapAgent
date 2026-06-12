import { useMultiFileAuthState } from 'baileys';
import logger from '../logger.js';

/**
 * Cached wrapper around Baileys' useMultiFileAuthState.
 *
 * The Baileys auth state stores keys in many small JSON files. On every
 * `keys.get()` call it reads from disk, which becomes expensive at high
 * message throughput. This module keeps an in-memory Map cache in front of
 * the disk state so that repeated reads of the same key type/id pair are
 * served from RAM instead of hitting the filesystem.
 *
 * The `set` method updates both the in-memory cache AND persists to disk via
 * the original `state.keys.set()`, so credentials are never lost.
 */
export async function useCachedAuthState(folder: string) {
  const { state, saveCreds } = await useMultiFileAuthState(folder);

  // Map<type, Map<id, value>>
  const cache = new Map<string, Map<string, any>>();

  const cachedKeys = {
    get: async (type: any, ids: string[]) => {
      if (!cache.has(type)) cache.set(type, new Map());
      const typeCache = cache.get(type)!;

      const result: Record<string, any> = {};
      const missing: string[] = [];

      for (const id of ids) {
        if (typeCache.has(id)) {
          result[id] = typeCache.get(id);
        } else {
          missing.push(id);
        }
      }

      if (missing.length > 0) {
        const fromDisk = await state.keys.get(type, missing);
        for (const id of missing) {
          if (fromDisk?.[id] != null) {
            result[id] = fromDisk[id];
            typeCache.set(id, fromDisk[id]); // cache miss → fill cache
          }
        }
      }

      return result;
    },

    set: async (data: any) => {
      // Update cache + persist to disk
      for (const [type, typeData] of Object.entries(data)) {
        if (!cache.has(type)) cache.set(type, new Map());
        const typeCache = cache.get(type)!;
        for (const [id, val] of Object.entries(typeData as Record<string, any>)) {
          if (val != null) typeCache.set(id, val);
          else typeCache.delete(id); // null = key removed
        }
      }
      await state.keys.set(data);
    },
  };

  logger.info(
    { cacheTypes: () => cache.size },
    'cached auth state initialized',
  );

  return {
    state: { ...state, keys: cachedKeys },
    saveCreds,
    getCache: () => cache, // optional, for monitoring
  };
}
