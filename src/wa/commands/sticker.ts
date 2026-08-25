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
import { downloadMediaToFile, mapMediaKind, shouldRetryStickerAsImage } from '../../mediaHandler.js';
import config from '../../config.js';
import { withTimeout } from '../utils.js';
import type { DownloadableMessage } from 'baileys';
import type { CommandContext, CommandHandler } from '../command/CommandContext.js';

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
const SUPPORTED_VIDEO_EXT = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.webp', '.3gp', '.gif']);

// Meme text font. The bundled TTF (Anton, SIL OFL — an Impact-style face) is
// embedded into every text overlay via @font-face so librsvg renders true
// meme lettering even on hosts without Impact installed; without this it
// silently falls back to a generic sans-serif. STICKER_FONT_PATH may point at
// any other TTF (e.g. genuine impact.ttf) and takes priority.
const MEME_FONT_FAMILY = 'WazzapMeme';
const BUNDLED_MEME_FONT_URL = new URL('../assets/fonts/Anton-Regular.ttf', import.meta.url);

type MemeFontCache = { key: string; css: string };
let memeFontCache: MemeFontCache | null = null;

/** Build (and memoize) the @font-face CSS for the embedded meme font. */
function memeFontFaceCss(): string {
  const configuredPath = config.stickerFontPath;
  const candidates: Array<{ key: string; source: string; read: () => Buffer }> = [];
  if (configuredPath) {
    candidates.push({
      key: `file:${configuredPath}`,
      source: configuredPath,
      read: () => fs.readFileSync(configuredPath),
    });
  }
  candidates.push({
    key: 'bundled',
    source: BUNDLED_MEME_FONT_URL.href,
    read: () => fs.readFileSync(BUNDLED_MEME_FONT_URL),
  });

  if (memeFontCache && memeFontCache.key === candidates[0].key) return memeFontCache.css;

  let css = '';
  for (const candidate of candidates) {
    try {
      const base64 = candidate.read().toString('base64');
      css = `@font-face{font-family:'${MEME_FONT_FAMILY}';src:url(data:font/ttf;base64,${base64}) format('truetype');}`;
      break;
    } catch (err) {
      logger.warn({ err, path: candidate.source }, 'failed to load /sticker meme font, trying next candidate');
    }
  }

  memeFontCache = { key: candidates[0].key, css };
  return css;
}

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
  content: DownloadableMessage,
  contentType: string | null | undefined,
  messageId: string | null | undefined,
  mediaDir: string = config.mediaDir,
): Promise<string | null> {
  const mediaKind = mapMediaKind(contentType);
  if (!mediaKind || !['image', 'video', 'sticker'].includes(mediaKind)) return null;

  try {
    const extMap: Record<string, string> = { image: 'jpg', video: 'mp4', sticker: 'webp' };
    const ext = extMap[mediaKind] || 'bin';
    const filename = `${messageId}_${mediaKind}.${ext}`;
    const filepath = path.join(mediaDir, filename);
    try {
      await downloadMediaToFile(content, mediaKind as 'image' | 'video' | 'sticker', filepath, withTimeout);
    } catch (err) {
      if (mediaKind !== 'sticker' || !shouldRetryStickerAsImage(err)) throw err;
      logger.warn({ err, messageId }, 'sticker decrypt failed, retrying as image');
      await fs.remove(filepath).catch(() => {});
      await downloadMediaToFile(content, 'image', filepath, withTimeout);
    }
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

/**
 * Compute a conservative font size for a single line of meme text.
 * The SVG also applies an exact textLength below, so the minimum size can
 * remain readable without allowing very long text to escape the canvas.
 */
function fitFontSize(text: string, maxWidth: number, size: number): number {
  const MIN = Math.round(size * 0.035); // ≈ 18px at 512
  const MAX = Math.round(size * 0.10);  // ≈ 51px at 512
  if (!text.length) return MAX;
  // Meme fonts (Anton/Impact/Arial Black) capitals average roughly 0.62em
  // wide. Leave a little extra room for the 1px letter spacing used by the
  // overlay.
  const ideal = Math.floor((maxWidth - Math.max(0, text.length - 1)) / (text.length * 0.62));
  return Math.min(MAX, Math.max(MIN, ideal));
}

type StickerMediaCandidate = {
  content: DownloadableMessage;
  contentType: 'imageMessage' | 'videoMessage' | 'stickerMessage';
  isAnimated: boolean;
};

function stickerMediaCandidate(
  contentType: string | null | undefined,
  message: {
    imageMessage?: DownloadableMessage | null;
    videoMessage?: (DownloadableMessage & { gifPlayback?: boolean | null }) | null;
    stickerMessage?: (DownloadableMessage & { isAnimated?: boolean | null }) | null;
  } | null | undefined,
): StickerMediaCandidate | null {
  if (contentType === 'imageMessage' && message?.imageMessage) {
    return { content: message.imageMessage, contentType, isAnimated: false };
  }
  if (contentType === 'videoMessage' && message?.videoMessage) {
    return { content: message.videoMessage, contentType, isAnimated: true };
  }
  if (contentType === 'stickerMessage' && message?.stickerMessage) {
    return {
      content: message.stickerMessage,
      contentType,
      isAnimated: Boolean(message.stickerMessage.isAnimated),
    };
  }
  return null;
}

type ImageBounds = { left: number; top: number; width: number; height: number };

/** Locate the image inside the square canvas produced by Sharp's `fit: contain`. */
function containImageBounds(sourceWidth: number, sourceHeight: number, size: number): ImageBounds {
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: size, height: size };
  }

  const scale = Math.min(size / sourceWidth, size / sourceHeight);
  const width = Math.max(1, Math.min(size, Math.round(sourceWidth * scale)));
  const height = Math.max(1, Math.min(size, Math.round(sourceHeight * scale)));
  return {
    left: Math.floor((size - width) / 2),
    top: Math.floor((size - height) / 2),
    width,
    height,
  };
}

/**
 * Build an SVG overlay with meme-style text (white fill, black stroke).
 * Font size scales with text length: short text gets a large font, long text
 * gets a smaller font, always fitting within the sticker width.
 */
function buildTextOverlaySvg(
  size: number,
  upperText: string | null,
  lowerText: string | null,
  imageBounds: ImageBounds = { left: 0, top: 0, width: size, height: size },
): Buffer | null {
  if (!upperText && !lowerText) return null;

  const fontFaceCss = memeFontFaceCss();

  const padding = Math.max(2, Math.round(Math.min(imageBounds.width, imageBounds.height) * 0.04));
  const escapeXml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const maxWidth = Math.max(1, imageBounds.width - padding * 2);
  const lineCount = Number(Boolean(upperText)) + Number(Boolean(lowerText));
  const availableHeight = Math.max(1, imageBounds.height - padding * 2);
  const maxFontByHeight = Math.max(6, Math.floor(availableHeight / (lineCount > 1 ? 2.25 : 1.15)));
  const textElements: string[] = [];

  function addText(text: string, position: 'top' | 'bottom') {
    const upper = text.toUpperCase();
    const fontSize = Math.min(fitFontSize(upper, maxWidth, size), maxFontByHeight);
    const strokeWidth = Math.max(2, Math.round(fontSize * 0.08));
    const estimatedWidth = upper.length * fontSize * 0.62 + Math.max(0, upper.length - 1);
    // textLength is enforced by the SVG renderer. It prevents font-metric
    // differences (or the minimum font size) from pushing text past the image.
    const textLength = Math.max(1, Math.min(Math.floor(estimatedWidth), maxWidth - strokeWidth * 2));
    const attrs = `font-family="${MEME_FONT_FAMILY}, Impact, Arial Black, sans-serif" font-size="${fontSize}" font-weight="bold" text-anchor="middle" fill="white" stroke="black" stroke-width="${strokeWidth}" paint-order="stroke" letter-spacing="1" textLength="${textLength}" lengthAdjust="spacingAndGlyphs"`;
    const y = position === 'top'
      ? imageBounds.top + padding + fontSize
      : imageBounds.top + imageBounds.height - padding;
    const x = imageBounds.left + imageBounds.width / 2;
    textElements.push(`<text x="${x}" y="${y}" ${attrs}>${escapeXml(upper)}</text>`);
  }

  if (upperText) addText(upperText, 'top');
  if (lowerText) addText(lowerText, 'bottom');

  const defs = fontFaceCss ? `<defs><style>${fontFaceCss}</style></defs>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${defs}${textElements.join('')}</svg>`;
  return Buffer.from(svg);
}

async function createStickerFile(mediaPath: string, upperText: string | null = null, lowerText: string | null = null, mediaDir: string = config.mediaDir): Promise<string> {
  const ext = path.extname(mediaPath).toLowerCase();

  if (!SUPPORTED_IMAGE_EXT.has(ext)) {
    throw new Error(`Unsupported format: ${ext}`);
  }

  await fs.ensureDir(mediaDir);
  const shortId = randomUUID().slice(0, 8);
  const outPath = path.join(mediaDir, `sticker_${shortId}.webp`);

  // Reading into memory prevents Sharp from retaining a Windows file handle
  // to a replied WebP sticker, which would block cleanup in handleSticker.
  const mediaBuffer = await fs.readFile(mediaPath);
  const metadata = await sharp(mediaBuffer).metadata();
  const imageBounds = metadata.width && metadata.height
    ? containImageBounds(metadata.width, metadata.height, STICKER_SIZE)
    : { left: 0, top: 0, width: STICKER_SIZE, height: STICKER_SIZE };

  let img = sharp(mediaBuffer).resize(STICKER_SIZE, STICKER_SIZE, {
    fit: 'contain',
    withoutEnlargement: false,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  });

  const overlaysvg = buildTextOverlaySvg(STICKER_SIZE, upperText, lowerText, imageBounds);
  if (overlaysvg) {
    img = img.composite([{ input: overlaysvg, blend: 'over' }]);
  }

  await img.webp({ quality: 95 }).toFile(outPath);
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
    mediaDir?: string;
  } = {},
): Promise<string> {
  const {
    maxDuration = MAX_ANIMATED_DURATION,
    maxSizeKb = MAX_ANIMATED_SIZE_KB,
    fps = DEFAULT_FPS,
    quality = DEFAULT_QUALITY,
    packName = STICKER_PACK_NAME,
    emoji = STICKER_EMOJI,
    mediaDir = config.mediaDir,
  } = options;

  const ext = path.extname(inputPath).toLowerCase();
  if (!SUPPORTED_VIDEO_EXT.has(ext)) {
    throw new Error(`Unsupported video format: ${ext}`);
  }

  await fs.ensureDir(mediaDir);
  const shortId = randomUUID().slice(0, 8);
  const outPath = path.join(mediaDir, `sticker_${shortId}.webp`);

  // Level 1: Best quality (512px, configurable fps/quality, up to maxDuration seconds)
  await convertVideoToWebp(inputPath, outPath, {
    maxDuration, fps, quality, size: STICKER_SIZE,
  });

  const maxBytes = maxSizeKb * 1024;
  let currentPath = outPath;
  let currentSize = (await fs.stat(currentPath)).size;

  // Level 2 fallback: reduced fps, quality, shorter duration
  if (currentSize > maxBytes) {
    const fallbackPath = path.join(mediaDir, `sticker_${shortId}_f1.webp`);
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
    const smallPath = path.join(mediaDir, `sticker_${shortId}_f2.webp`);
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

async function handleSticker({ chatId, chatType: _chatType, senderIsAdmin: _senderIsAdmin, senderIsOwner: _senderIsOwner, args, msg, account, sock }: CommandContext): Promise<void> {
  const [upperText, lowerText] = parseStickerArgs(args);
  // Per-tenant media dir (CONTRACT.md §8): the produced sticker file must live
  // under THIS account's media dir so the outbound attachment allowlist (now
  // tenant-scoped) accepts it.
  const mediaDir = account?.mediaDir ?? config.mediaDir;

  const { contentType, message: innerMessage } = unwrapMessage(msg!.message) || {};
  let mediaPath: string | null = null;
  let isAnimated = false;

  const reactWithProgress = async (emoji: string): Promise<void> => {
    try {
      await sock.sendMessage(chatId, { react: { text: emoji, key: msg!.key } });
    } catch (err) {
      logger.warn({ err, chatId, emoji }, 'failed to update sticker progress reaction');
    }
  };

  // Case 1: message IS the media (e.g. image sent with caption "/sticker")
  const directMedia = stickerMediaCandidate(contentType, innerMessage);
  if (directMedia) {
    await reactWithProgress('⬇️');
    mediaPath = await downloadMediaContent(directMedia.content, directMedia.contentType, msg!.key.id, mediaDir);
    isAnimated = directMedia.isAnimated;
  }

  // Case 2: message is a text reply to a media message (extendedTextMessage with contextInfo)
  if (!mediaPath) {
    // contextInfo can be on text or directly on any supported media message.
    const contextInfo =
      innerMessage?.extendedTextMessage?.contextInfo ??
      innerMessage?.imageMessage?.contextInfo ??
      innerMessage?.videoMessage?.contextInfo ??
      innerMessage?.stickerMessage?.contextInfo;

    if (contextInfo?.quotedMessage) {
      const { contentType: qType, message: qMsg } = unwrapMessage(contextInfo.quotedMessage) || {};
      const quotedMedia = stickerMediaCandidate(qType, qMsg);
      if (quotedMedia) {
        await reactWithProgress('⬇️');
        mediaPath = await downloadMediaContent(
          quotedMedia.content,
          quotedMedia.contentType,
          contextInfo.stanzaId,
          mediaDir,
        );
        isAnimated = quotedMedia.isAnimated;
      }
    }
  }

  if (!mediaPath) {
    try {
      await sock.sendMessage(chatId, {
        text: 'Send an image/video with the caption `/sticker`, or reply to an image/video/sticker with `/sticker`.',
      });
    } catch (err) { /* ignore */ }
    return;
  }

  await reactWithProgress('🔁');

  let stickerPath: string | null = null;
  try {
    if (isAnimated) {
      stickerPath = await createAnimatedStickerFile(mediaPath, { mediaDir });
    } else {
      stickerPath = await createStickerFile(mediaPath, upperText, lowerText, mediaDir);
    }

    await sendOutgoing(account!, {
      chatId,
      attachments: [{ kind: 'sticker', path: stickerPath }],
      replyTo: msg!.key.id as string,
    });
    await reactWithProgress('✅');
    logger.info({ chatId, isAnimated }, 'Sticker created and sent');
  } catch (err: unknown) {
    logger.error({ err, chatId, isAnimated }, 'failed to create sticker');
    try {
      await sock.sendMessage(chatId, { text: `Failed to create sticker: ${err instanceof Error ? err.message : String(err)}` });
    } catch (e) { /* ignore */ }
  } finally {
    // Cleanup the downloaded media file (input)
    if (mediaPath) {
      try { await fs.remove(mediaPath); } catch { /* ignore */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await reactWithProgress('');
  }
}

export { handleSticker };

// Exported for focused regression tests; not part of the command interface.
export const stickerTextInternals = {
  MEME_FONT_FAMILY,
  fitFontSize,
  containImageBounds,
  buildTextOverlaySvg,
  createStickerFile,
  stickerMediaCandidate,
};

export const stickerCommand: CommandHandler = {
  commands: ["sticker", "stickers"],
  description: "Create a WhatsApp sticker from an image, video, or existing sticker. Send an image with the caption `/sticker` or reply to an image/video/sticker with `/sticker`. Add meme text with the format `/sticker top_text#bottom_text`. Example: `/sticker so me#when monday arrives`.",
  permission: "public",
  run: (_sock, _message, ctx) => handleSticker(ctx),
};
