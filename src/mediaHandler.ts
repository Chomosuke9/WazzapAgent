import path from 'path';
import fs from 'fs-extra';
import { downloadContentFromMessage } from 'baileys';
import type { MediaType } from 'baileys';
import logger from './logger.js';
import config from './config.js';
import { streamToFile } from './utils/index.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Concrete media kinds saveMedia knows how to persist.
 */
type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'sticker';

/**
 * Result of {@link mapMediaKind}: a concrete {@link MediaKind} or the
 * `'unknown'` sentinel for unsupported content types.
 */
type MediaKindOrUnknown = MediaKind | 'unknown';

/**
 * Factory that builds a tagged error (with a stable error `code`) for action
 * failures. Mirrors the gateway's `actionError` helper.
 */
type ActionErrorFactory = (code: string, message: string) => Error;

/**
 * Wraps a promise with a timeout/label, rejecting if it does not settle in time.
 */
type WithTimeout = <T>(promise: Promise<T>, ms: number, label: string) => Promise<T>;

/**
 * The inbound media attachment produced by {@link saveMedia}.
 *
 * Matches the `attachments[]` entry shape documented in CONTRACT.md §7
 * (`WhatsAppMessage.attachments`). It is a superset of the wire `Attachment`
 * (CONTRACT.md §1) carrying the inbound-only fields (`originalFileName`,
 * `size`, `jpegThumbnail`, `isAnimated`). No wire shape is changed here.
 */
export interface SavedAttachment {
  kind: MediaKind;
  mime: string;
  fileName: string;
  originalFileName: string | null;
  jpegThumbnail: string | null;
  size: number;
  path: string;
  isAnimated: boolean;
}

function isPathWithin(basePath: string, candidatePath: string): boolean {
  const relative = path.relative(basePath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveAllowedAttachmentPath(rawPath: unknown, actionError: ActionErrorFactory): Promise<string> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw actionError('invalid_target', 'attachment path is required');
  }
  const candidate = path.resolve(rawPath.trim());
  if (!await fs.pathExists(candidate)) {
    throw actionError('not_found', `attachment not found: ${rawPath}`);
  }

  // User-uploaded stickers live in a separate directory that is not
  // config.stickersDir (which holds admin-managed static stickers).
  const stickerUploadDir = config.stickerUploadDir;
  // Ensure the directory exists before calling realpath on it
  await fs.ensureDir(stickerUploadDir);

  const [mediaDirRealPath, stickersDirRealPath, stickerUploadDirRealPath, candidateRealPath] = await Promise.all([
    fs.realpath(config.mediaDir),
    fs.realpath(config.stickersDir),
    fs.realpath(stickerUploadDir),
    fs.realpath(candidate),
  ]);
  const isInMediaDir = isPathWithin(mediaDirRealPath, candidateRealPath);
  const isInStickersDir = isPathWithin(stickersDirRealPath, candidateRealPath);
  const isInStickerUploadDir = isPathWithin(stickerUploadDirRealPath, candidateRealPath);
  if (!isInMediaDir && !isInStickersDir && !isInStickerUploadDir) {
    throw actionError('invalid_target', `attachment path must be inside media or stickers dir: ${config.mediaDir}, ${config.stickersDir}, or ${stickerUploadDir}`);
  }
  const stat = await fs.stat(candidateRealPath);
  if (!stat.isFile()) {
    throw actionError('invalid_target', 'attachment path must point to a file');
  }
  return candidateRealPath;
}

function inferExtension(mime: string | null | undefined): string {
  const normalized = normalizeMime(mime);
  if (!normalized) return 'bin';
  if (normalized.includes('jpeg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('bmp')) return 'bmp';
  if (normalized.includes('heic')) return 'heic';
  if (normalized.includes('heif')) return 'heif';
  if (normalized.includes('avif')) return 'avif';
  if (normalized === 'video/x-matroska' || normalized.includes('matroska')) return 'mkv';
  if (normalized === 'video/quicktime' || normalized.includes('quicktime')) return 'mov';
  if (normalized === 'video/x-msvideo' || normalized.includes('msvideo')) return 'avi';
  // Order matters: ``audio/mp4`` and ``audio/x-m4a`` must be checked before the
  // generic ``includes('mp4')`` fallback, otherwise audio files would all get
  // a ``.mp4`` extension instead of ``.m4a``.
  if (normalized === 'audio/mp4' || normalized === 'audio/x-m4a') return 'm4a';
  if (normalized === 'video/mp4' || normalized.includes('mp4')) return 'mp4';
  if (normalized === 'audio/mpeg' || normalized.includes('mp3')) return 'mp3';
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav') return 'wav';
  if (normalized === 'audio/flac') return 'flac';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('pdf')) return 'pdf';
  if (normalized.includes('wordprocessingml')) return 'docx';
  if (normalized.includes('spreadsheetml')) return 'xlsx';
  if (normalized.includes('presentationml')) return 'pptx';
  if (normalized.includes('opendocument.text')) return 'odt';
  if (normalized.includes('opendocument.spreadsheet')) return 'ods';
  if (normalized.includes('opendocument.presentation')) return 'odp';
  if (normalized.includes('rtf')) return 'rtf';
  if (normalized.includes('7z-compressed')) return '7z';
  if (normalized.includes('vnd.rar') || normalized === 'application/x-rar-compressed') return 'rar';
  if (normalized.includes('gzip')) return 'gz';
  if (normalized.includes('x-tar')) return 'tar';
  if (normalized.includes('zip')) return 'zip';
  if (normalized === 'text/plain') return 'txt';
  if (normalized === 'text/csv') return 'csv';
  if (normalized === 'text/html') return 'html';
  if (normalized === 'application/json') return 'json';
  if (normalized === 'application/xml' || normalized === 'text/xml') return 'xml';
  return normalized.split('/').pop() || 'bin';
}

function normalizeMime(mime: unknown): string | null {
  if (typeof mime !== 'string') return null;
  const normalized = mime.split(';')[0].trim().toLowerCase();
  return normalized || null;
}

function detectMimeFromHeader(header: Buffer | null | undefined): string | null {
  if (!Buffer.isBuffer(header) || header.length === 0) return null;

  if (
    header.length >= 12
    && header.toString('ascii', 0, 4) === 'RIFF'
    && header.toString('ascii', 8, 12) === 'WEBP'
  ) return 'image/webp';
  if (
    header.length >= 8
    && header[0] === 0x89
    && header[1] === 0x50
    && header[2] === 0x4E
    && header[3] === 0x47
    && header[4] === 0x0D
    && header[5] === 0x0A
    && header[6] === 0x1A
    && header[7] === 0x0A
  ) return 'image/png';
  if (header.length >= 3 && header[0] === 0xFF && header[1] === 0xD8 && header[2] === 0xFF) return 'image/jpeg';
  const gifMagic = header.toString('ascii', 0, 6);
  if (gifMagic === 'GIF87a' || gifMagic === 'GIF89a') return 'image/gif';
  if (header.length >= 4 && header.toString('ascii', 0, 4) === '%PDF') return 'application/pdf';
  if (
    header.length >= 4
    && header[0] === 0x50
    && header[1] === 0x4B
    && (header[2] === 0x03 || header[2] === 0x05 || header[2] === 0x07)
    && (header[3] === 0x04 || header[3] === 0x06 || header[3] === 0x08)
  ) return 'application/zip';
  if (header.length >= 4 && header.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (header.length >= 3 && header.toString('ascii', 0, 3) === 'ID3') return 'audio/mp3';
  if (header.length >= 2 && header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) return 'audio/mp3';
  if (header.length >= 8 && header.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';

  return null;
}

async function readFileHeader(filepath: string, bytes = 16): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = fs.createReadStream(filepath, { start: 0, end: bytes - 1 });
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function detectMimeFromFile(filepath: string): Promise<string | null> {
  try {
    const header = await readFileHeader(filepath, 16);
    return detectMimeFromHeader(header);
  } catch (err) {
    logger.debug({ err, filepath }, 'failed to inspect saved media header');
    return null;
  }
}

function shouldRetryStickerAsImage(err: unknown): boolean {
  const message = String((err as { message?: unknown } | null | undefined)?.message || '').toLowerCase();
  if (!message) return false;
  return (
    message.includes('bad decrypt')
    || message.includes('unable to authenticate data')
    || message.includes('wrong final block length')
    || message.includes('mac check failed')
    || message.includes('failed to decrypt')
  );
}

async function downloadMediaToFile(
  content: any,
  mediaKind: MediaType,
  filepath: string,
  withTimeout: WithTimeout,
): Promise<number> {
  const stream = await withTimeout(
    downloadContentFromMessage(content, mediaKind),
    config.downloadTimeoutMs,
    `downloadContentFromMessage(${mediaKind})`
  );
  return withTimeout(
    streamToFile(stream, filepath),
    config.downloadTimeoutMs,
    `streamToFile(${mediaKind})`
  );
}

function mapMediaKind(contentType: string | null | undefined): MediaKindOrUnknown {
  if (contentType === 'imageMessage') return 'image';
  if (contentType === 'videoMessage') return 'video';
  if (contentType === 'audioMessage') return 'audio';
  if (contentType === 'documentMessage') return 'document';
  if (contentType === 'stickerMessage') return 'sticker';
  return 'unknown';
}

async function saveMedia(
  contentType: string | null | undefined,
  content: any,
  messageId: string,
  withTimeout: WithTimeout,
): Promise<SavedAttachment | null> {
  const kind = mapMediaKind(contentType);
  if (kind === 'unknown') return null;
  const declaredMime = normalizeMime(content?.mimetype);
  let mime = declaredMime || (kind === 'sticker' ? 'image/webp' : 'application/octet-stream');
  let ext = inferExtension(mime);
  let filename = `${messageId}_${kind}.${ext}`;
  let filepath = path.join(config.mediaDir, filename);
  let usedImageFallback = false;

  // Preserve the original filename from WhatsApp (e.g. documentMessage.fileName).
  // Falls back to null for media types that don't carry a fileName.
  const originalFileName: string | null = content?.fileName || null;

  // Preserve the JPEG thumbnail for document previews.  Baileys decodes
  // the proto ``bytes`` field as a Buffer or Uint8Array; convert to
  // base64 for JSON-safe transport to the Python bridge.
  const rawThumbnail = content?.jpegThumbnail;
  let jpegThumbnail: string | null = null;
  if (rawThumbnail) {
    if (typeof rawThumbnail === 'string' && rawThumbnail.length > 0) {
      // Already base64 (unlikely from Baileys, but defensive).
      jpegThumbnail = rawThumbnail;
    } else if ((Buffer.isBuffer(rawThumbnail) || ArrayBuffer.isView(rawThumbnail)) && (rawThumbnail as Uint8Array).length > 0) {
      jpegThumbnail = Buffer.from(rawThumbnail as Uint8Array).toString('base64');
    }
  }

  let size: number;
  try {
    size = await downloadMediaToFile(content, kind, filepath, withTimeout);
  } catch (err) {
    if (kind !== 'sticker' || !shouldRetryStickerAsImage(err)) throw err;
    logger.warn({ err, messageId }, 'sticker decrypt failed with kind=sticker, retry as image');
    await fs.remove(filepath).catch(() => {});
    usedImageFallback = true;
    size = await downloadMediaToFile(content, 'image', filepath, withTimeout);
  }

  const shouldUseDetectedMime = !declaredMime || declaredMime === 'application/octet-stream' || usedImageFallback;
  const detectedMime = shouldUseDetectedMime ? await detectMimeFromFile(filepath) : null;
  if (detectedMime) {
    mime = detectedMime;
    ext = inferExtension(mime);
    const detectedFilename = `${messageId}_${kind}.${ext}`;
    const detectedFilepath = path.join(config.mediaDir, detectedFilename);
    if (detectedFilepath !== filepath) {
      await fs.move(filepath, detectedFilepath, { overwrite: true });
      filename = detectedFilename;
      filepath = detectedFilepath;
    }
  }

  return {
    kind,
    mime,
    fileName: filename,
    originalFileName,
    jpegThumbnail,
    size,
    path: filepath,
    isAnimated: Boolean(content?.isAnimated),
  };
}

export {
  isPathWithin,
  resolveAllowedAttachmentPath,
  inferExtension,
  normalizeMime,
  detectMimeFromHeader,
  readFileHeader,
  detectMimeFromFile,
  shouldRetryStickerAsImage,
  downloadMediaToFile,
  mapMediaKind,
  saveMedia,
};
