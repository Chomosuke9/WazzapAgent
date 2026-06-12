import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs-extra';
import { randomUUID } from 'crypto';
import webpmux from 'node-webpmux';
const { Image: WebpImage } = webpmux;
import logger from '../../logger.js';
import { sendOutgoing } from '../outbound.js';
import { unwrapMessage } from '../domain/messageParser.js';
import { downloadMediaToFile, mapMediaKind } from '../../mediaHandler.js';
import config from '../../config.js';
import { withTimeout } from '../utils.js';
import type { CommandContext, CommandHandler } from '../commands/CommandContext.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STICKER_SIZE = 512;
const MAX_ANIMATED_DURATION = config.stickerMaxDurationSec;
const MAX_ANIMATED_SIZE_KB = config.stickerMaxSizeKb;
const DEFAULT_FPS = config.stickerFps;
const DEFAULT_QUALITY = config.stickerQuality;
const STICKER_PACK_NAME = config.stickerPackName;
const STICKER_EMOJI = config.stickerEmoji;

const SUPPORTED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const SUPPORTED_VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.3gp', '.gif']);

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseStickerArgs(args: string | undefined): [string | null, string | null] {
  if (!args || !args.trim()) return [null, null];
  if (args.includes('#')) {
    const [upper, lower] = args.split('#');
    return [upper.trim() || null, lower.trim() || null];
  }
  return [args.trim() || null, null];
}

// ---------------------------------------------------------------------------
// Media download helper
// ---------------------------------------------------------------------------

async function downloadMediaContent(
  content: any,
  contentType: string | null | undefined,
  messageId: string | null | undefined,
): Promise<string | null> {
  const mediaKind = mapMediaKind(contentType);
  if (!mediaKind || !['image', 'video'].includes(mediaKind)) return null;

  try {
    const extMap: Record<string, string> = { image: 'jpg', video: 'mp4' };
    const ext = extMap[mediaKind] || 'bin';
    const filename = `${messageId}_${mediaKind}.${ext}`;
    const filepath = path.join(config.mediaDir, filename);
    await downloadMediaToFile(content, mediaKind as 'image' | 'video', filepath, withTimeout);
    return filepath;
  } catch (err) {
    logger.warn({ err, messageId, contentType }, 'failed to download media for sticker');
    return null;
  }
}

// ---------------------------------------------------------------------------
// EXIF metadata injection (sticker pack name + emoji)
// ---------------------------------------------------------------------------

async function addStickerExif(webpPath: string, { packName, emoji }: { packName: string; emoji: string }): Promise<void> {
  const img = new WebpImage();
  await img.load(webpPath);

  const json = {
    'sticker-pack-id': randomUUID(),
    'sticker-pack-name': packName,
    'emojis': [emoji],
  };

  const jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  // TIFF little-endian IFD with one entry: tag 0x5741 ('AW')
  const exifAttr = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00,
  ]);
  const exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);

  img.exif = exif;
  const finalBuffer = await img.save(null);
  await fs.writeFile(webpPath, finalBuffer);
}

// ---------------------------------------------------------------------------
// Static image sticker (sharp)
// ---------------------------------------------------------------------------

async function createStickerFile(mediaPath: string, upperText: string | null = null, lowerText: string | null = null): Promise<string> {
  const ext = path.extname(mediaPath).toLowerCase();

  if (!SUPPORTED_IMAGE_EXT.has(ext)) {
    throw new Error(`Unsupported format: ${ext}`);
  }

  await fs.ensureDir(config.mediaDir);
  const shortId = randomUUID().slice(0, 8);
  const outPath = path.join(config.mediaDir, `sticker_${shortId}.webp`);

  const img = sharp(mediaPath).resize(STICKER_SIZE, STICKER_SIZE, {
    fit: 'contain',
    withoutEnlargement: false,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  await img.webp({ quality: 95 }).toFile(outPath);

  // NOTE: `upperText`/`lowerText` (parsed from `/sticker upper#lower`) are
  // accepted but intentionally not drawn here. Static stickers ship as the
  // resized image only; meme-text overlay is a deferred enhancement and would
  // be implemented with sharp's SVG composite. Behavior is unchanged.

  await addStickerExif(outPath, { packName: STICKER_PACK_NAME, emoji: STICKER_EMOJI });

  return outPath;
}

// ---------------------------------------------------------------------------
// Animated sticker (video/GIF → WebP via ffmpeg)
// ---------------------------------------------------------------------------

function convertVideoToWebp(
  inputPath: string,
  outputPath: string,
  { maxDuration, fps, quality, size }: { maxDuration?: number; fps: number; quality: number; size: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let cmd = ffmpeg(inputPath)
      .outputOptions([
        '-vf', `scale=${size}:${size}:force_original_aspect_ratio=decrease,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=#00000000,fps=${fps}`,
        '-c:v', 'libwebp',
        '-preset', 'default',
        '-loop', '0',
        '-vsync', '0',
        '-pix_fmt', 'yuva420p',
        '-compression_level', '6',
      ])
      .outputOption('-quality', String(quality))
      .noAudio()
      .format('webp')
      .on('error', (err: Error) => reject(new Error(`ffmpeg conversion failed: ${err.message}`)))
      .on('end', () => resolve(outputPath));

    if (maxDuration) {
      cmd = cmd.duration(maxDuration);
    }

    cmd.save(outputPath);
  });
}

async function createAnimatedStickerFile(
  inputPath: string,
  options: {
    maxDuration?: number;
    maxSizeKb?: number;
    fps?: number;
    quality?: number;
    packName?: string;
    emoji?: string;
  } = {},
): Promise<string> {
  const {
    maxDuration = MAX_ANIMATED_DURATION,
    maxSizeKb = MAX_ANIMATED_SIZE_KB,
    fps = DEFAULT_FPS,
    quality = DEFAULT_QUALITY,
    packName = STICKER_PACK_NAME,
    emoji = STICKER_EMOJI,
  } = options;

  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_VIDEO_EXT.has(ext)) {
    throw new Error(`Unsupported video format: ${ext}`);
  }

  await fs.ensureDir(config.mediaDir);
  const shortId = randomUUID().slice(0, 8);
  const outPath = path.join(config.mediaDir, `sticker_${shortId}.webp`);

  // Level 1: Best quality (512px, configurable fps/quality, up to maxDuration seconds)
  await convertVideoToWebp(inputPath, outPath, {
    maxDuration, fps, quality, size: STICKER_SIZE,
  });

  const maxBytes = maxSizeKb * 1024;
  let currentPath = outPath;
  let currentSize = (await fs.stat(currentPath)).size;

  // Level 2 fallback: reduced fps, quality, shorter duration
  if (currentSize > maxBytes) {
    const fallbackPath = path.join(config.mediaDir, `sticker_${shortId}_f1.webp`);
    try {
      await convertVideoToWebp(inputPath, fallbackPath, {
        maxDuration: Math.min(maxDuration, 3),
        fps: 12,
        quality: 45,
        size: STICKER_SIZE,
      });
      const fallbackSize = (await fs.stat(fallbackPath)).size;
      if (fallbackSize < currentSize) {
        await fs.remove(currentPath);
        currentPath = fallbackPath;
        currentSize = fallbackSize;
      } else {
        await fs.remove(fallbackPath);
      }
    } catch (err) {
      logger.warn({ err }, 'Level 2 sticker compression failed');
      await fs.remove(fallbackPath).catch(() => {});
    }
  }

  // Level 3 fallback: small (320px), low fps, short duration, heavy compression
  if (currentSize > maxBytes) {
    const smallPath = path.join(config.mediaDir, `sticker_${shortId}_f2.webp`);
    try {
      await convertVideoToWebp(inputPath, smallPath, {
        maxDuration: 2,
        fps: 8,
        quality: 30,
        size: 320,
      });
      const smallSize = (await fs.stat(smallPath)).size;
      if (smallSize < currentSize) {
        await fs.remove(currentPath);
        currentPath = smallPath;
        currentSize = smallSize;
      } else {
        await fs.remove(smallPath);
      }
    } catch (err) {
      logger.warn({ err }, 'Level 3 sticker compression failed');
      await fs.remove(smallPath).catch(() => {});
    }
  }

  // Inject EXIF metadata (sticker pack name + emoji)
  await addStickerExif(currentPath, { packName, emoji });

  return currentPath;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function handleSticker({ chatId, chatType, senderIsAdmin, senderIsOwner, args, msg, account, sock }: CommandContext): Promise<void> {
  const [upperText, lowerText] = parseStickerArgs(args);

  const { contentType, message: innerMessage } = unwrapMessage(msg!.message) || {};
  let mediaPath: string | null = null;
  let isAnimated = false;

  if (contentType === 'imageMessage') {
    mediaPath = await downloadMediaContent(innerMessage![contentType], contentType, msg!.key.id);
  } else if (contentType === 'videoMessage') {
    mediaPath = await downloadMediaContent(innerMessage![contentType], contentType, msg!.key.id);
    isAnimated = true;
  }

  if (!mediaPath && innerMessage?.extendedTextMessage?.contextInfo) {
    const ctx = innerMessage.extendedTextMessage.contextInfo;
    if (ctx.quotedMessage) {
      const { contentType: qType, message: qMsg } = unwrapMessage(ctx.quotedMessage) || {};
      const qContent = qType ? qMsg?.[qType] : null;
      if (qType === 'imageMessage') {
        mediaPath = await downloadMediaContent(qContent, qType, ctx.stanzaId);
      } else if (qType === 'videoMessage') {
        mediaPath = await downloadMediaContent(qContent, qType, ctx.stanzaId);
        isAnimated = true;
      }
    }
  }

  if (!mediaPath) {
    try {
      await sock.sendMessage(chatId, {
        text: 'Kirim gambar/video dengan caption `/sticker`, atau reply gambar/video dengan `/sticker`.',
      });
    } catch (err) { /* ignore */ }
    return;
  }

  let stickerPath: string | null = null;
  try {
    if (isAnimated) {
      stickerPath = await createAnimatedStickerFile(mediaPath);
    } else {
      stickerPath = await createStickerFile(mediaPath, upperText, lowerText);
    }

    await sendOutgoing(account!, {
      chatId,
      attachments: [{ kind: 'sticker', path: stickerPath }],
      replyTo: msg!.key.id as string,
    });
    logger.info({ chatId, isAnimated }, 'Sticker created and sent');
  } catch (err: any) {
    logger.error({ err, chatId, isAnimated }, 'failed to create sticker');
    try {
      await sock.sendMessage(chatId, { text: `Failed to create sticker: ${err.message}` });
    } catch (e) { /* ignore */ }
  } finally {
    // Cleanup the downloaded media file (input)
    if (mediaPath) {
      try { await fs.remove(mediaPath); } catch { /* ignore */ }
    }
  }
}

export { handleSticker };

export const stickerCommand: CommandHandler = { name: "sticker", aliases: ["stickers"], run: handleSticker };