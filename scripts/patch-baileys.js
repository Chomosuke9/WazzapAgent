#!/usr/bin/env node
/**
 * scripts/patch-baileys.js
 *
 * Patches node_modules/baileys/lib/Socket/messages-send.js to add
 * groupStatusMessageV2 support in getMediaType().
 *
 * Run after install: node scripts/patch-baileys.js
 *
 * Why: Baileys' getMediaType() only checks top-level message keys.
 * When sending group status, the media is nested inside
 * groupStatusMessageV2.message — so getMediaType() returns '' and
 * the stanza <enc> node is missing the required mediatype attribute,
 * causing server error 479.
 *
 * gifted-baileys solves this with the same patch (gcstatus.js).
 */

import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const target = join(__dirname, '../node_modules/baileys/lib/Socket/messages-send.js');

const MARKER = "else if (message.groupStatusMessageV2)";
const NEEDLE = "        else if (message.groupInviteMessage) {\n            return 'url';\n        }\n        return '';";
const REPLACEMENT = `        else if (message.groupInviteMessage) {
            return 'url';
        }
        else if (message.groupStatusMessageV2) {
            const innerMsg = message.groupStatusMessageV2.message || {};
            if (innerMsg.imageMessage) return 'image';
            if (innerMsg.videoMessage) return innerMsg.videoMessage.gifPlayback ? 'gif' : 'video';
            if (innerMsg.audioMessage) return innerMsg.audioMessage.ptt ? 'ptt' : 'audio';
            if (innerMsg.stickerMessage) return 'sticker';
            return 'text';
        }
        return '';`;

let src;
try {
  src = readFileSync(target, 'utf8');
} catch {
  console.error('[patch-baileys] Could not read', target, '— skipping.');
  process.exit(0);
}

if (src.includes(MARKER)) {
  console.log('[patch-baileys] Already patched — skipping.');
  process.exit(0);
}

if (!src.includes(NEEDLE)) {
  console.error('[patch-baileys] Target string not found — Baileys may have been updated. Patch skipped.');
  process.exit(0);
}

writeFileSync(target, src.replace(NEEDLE, REPLACEMENT), 'utf8');
console.log('[patch-baileys] Patched baileys getMediaType() for groupStatusMessageV2 support.');
