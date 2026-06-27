import path from 'path';
import fs from 'fs-extra';
import { downloadContentFromMessage, downloadMediaMessage } from 'baileys';
import type { MediaType, WAMessage } from 'baileys';
import logger, { baileysLogger } from './logger.js';
import config from './config.js';
import { streamToFile } from './utils/index.js';
import type { WaSocketLike } from './protocol/ports.js';

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

export type AllowedAttachmentDirs = { mediaDir?: string; stickersDir?: string; stickerUploadDir?: string };

async function resolveAllowedAttachmentPath(
  rawPath: unknown,
  actionError: ActionErrorFactory,
  dirs?: AllowedAttachmentDirs,
): Promise<string> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw actionError('invalid_target', 'attachment path is required');
  }
  const candidate = path.resolve(rawPath.trim());
  if (!await fs.pathExists(candidate)) {
    throw actionError('not_found', `attachment not found: ${rawPath}`);
  }

  const mediaDir = dirs?.mediaDir ?? config.mediaDir;
  const stickersDir = dirs?.stickersDir ?? config.stickersDir;
  // User-uploaded stickers live in a separate directory that is not
  // stickersDir (which holds admin-managed static stickers).
  const stickerUploadDir = dirs?.stickerUploadDir ?? config.stickerUploadDir;
  // Ensure the directory exists before calling realpath on it
  await fs.ensureDir(stickerUploadDir);

  const [mediaDirRealPath, stickersDirRealPath, stickerUploadDirRealPath, candidateRealPath] = await Promise.all([
    fs.realpath(mediaDir),
    fs.realpath(stickersDir),
    fs.realpath(stickerUploadDir),
    fs.realpath(candidate),
  ]);
  const isInMediaDir = isPathWithin(mediaDirRealPath, candidateRealPath);
  const isInStickersDir = isPathWithin(stickersDirRealPath, candidateRealPath);
  const isInStickerUploadDir = isPathWithin(stickerUploadDirRealPath, candidateRealPath);
  if (!isInMediaDir && !isInStickersDir && !isInStickerUploadDir) {
    throw actionError('invalid_target', `attachment path must be inside media or stickers dir: ${mediaDir}, ${stickersDir}, or ${stickerUploadDir}`);
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

  const MIME_EXT: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'image/avif': 'avif',
    'video/x-matroska': 'mkv',
    'video/quicktime': 'mov',
    'video/x-msvideo': 'avi',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'video/mp4': 'mp4',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'application/x-rar-compressed': 'rar',
    'text/plain': 'txt',
    'text/csv': 'csv',
    'text/html': 'html',
    'application/json': 'json',
    'application/xml': 'xml',
    'text/xml': 'xml',
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'application/vnd.oasis.opendocument.text': 'odt',
    'application/vnd.oasis.opendocument.spreadsheet': 'ods',
    'application/vnd.oasis.opendocument.presentation': 'odp',
    'application/rtf': 'rtf',
    'application/x-7z-compressed': '7z',
    'application/vnd.rar': 'rar',
    'application/gzip': 'gz',
    'application/x-tar': 'tar',
    'application/zip': 'zip',
    'audio/ogg': 'ogg',
  };

  const exact = MIME_EXT[normalized];
  if (exact) return exact;

  // ponytail: substring fallback for non-standard MIME variants
  const SUBSTRINGS: [string, string][] = [
    ['jpeg', 'jpg'],
    ['png', 'png'],
    ['gif', 'gif'],
    ['webp', 'webp'],
    ['bmp', 'bmp'],
    ['heic', 'heic'],
    ['heif', 'heif'],
    ['avif', 'avif'],
    ['matroska', 'mkv'],
    ['quicktime', 'mov'],
    ['msvideo', 'avi'],
    ['mp4', 'mp4'],
    ['mp3', 'mp3'],
    ['ogg', 'ogg'],
    ['pdf', 'pdf'],
    ['wordprocessingml', 'docx'],
    ['spreadsheetml', 'xlsx'],
    ['presentationml', 'pptx'],
    ['opendocument.text', 'odt'],
    ['opendocument.spreadsheet', 'ods'],
    ['opendocument.presentation', 'odp'],
    ['rtf', 'rtf'],
    ['7z-compressed', '7z'],
    ['vnd.rar', 'rar'],
    ['gzip', 'gz'],
    ['x-tar', 'tar'],
    ['zip', 'zip'],
  ];

  for (const [sub, ext] of SUBSTRINGS) {
    if (normalized.includes(sub)) return ext;
  }

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
  refresh?: { fullMessage: WAMessage; sock: Pick<WaSocketLike, 'updateMediaMessage'> },
): Promise<number> {
  // When the full message + socket are available (the lazy-media `download_media`
  // path re-downloads a PREVIOUSLY-received message whose WhatsApp CDN URL may
  // have expired), use Baileys' `downloadMediaMessage` with a `reuploadRequest`.
  // It transparently asks WhatsApp to re-upload the media and refresh the URL on
  // an expired/`410`/stalled fetch, then retries — exactly the case that made an
  // older `download_media` hang until the timeout while fresh media worked. The
  // low-level `downloadContentFromMessage` below has no URL-refresh and is kept
  // for callers that only hold the raw content node (sticker/addsticker, which
  // operate on just-received media).
  if (refresh) {
    const stream = (await withTimeout(
      downloadMediaMessage(
        refresh.fullMessage,
        'stream',
        {},
        {
          logger: baileysLogger,
          reuploadRequest: refresh.sock.updateMediaMessage,
        },
      ),
      config.downloadTimeoutMs,
      `downloadMediaMessage(${mediaKind})`,
    )) as unknown as NodeJS.ReadableStream;
    return withTimeout(
      streamToFile(stream, filepath),
      config.downloadTimeoutMs,
      `streamToFile(${mediaKind})`,
    );
  }
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

/**
 * Extract the JPEG thumbnail (document/image preview) as a base64 string, if
 * present. Baileys decodes the proto `bytes` field as a Buffer/Uint8Array.
 */
function extractJpegThumbnail(content: any): string | null {
  const raw = content?.jpegThumbnail;
  if (!raw) return null;
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if ((Buffer.isBuffer(raw) || ArrayBuffer.isView(raw)) && (raw as Uint8Array).length > 0) {
    return Buffer.from(raw as Uint8Array).toString('base64');
  }
  return null;
}

/**
 * Inbound attachment metadata WITHOUT downloading the media bytes (feature 8).
 *
 * The gateway forwards this to the Python bridge so it knows an attachment
 * exists (kind/mime/name/thumbnail) without paying the download cost up front.
 * `path` is deliberately `null`: when the bridge actually needs the bytes
 * (vision, sticker creation, sub-agent) it issues a `download_media` action and
 * Node downloads on demand. `pending: true` marks it as not-yet-downloaded.
 *
 * Document `jpegThumbnail` is included so the bridge can render a document
 * preview to the LLM with no download at all.
 */
export interface PendingAttachment {
  kind: MediaKind;
  mime: string;
  fileName: string;
  originalFileName: string | null;
  jpegThumbnail: string | null;
  size: number;
  isAnimated: boolean;
  path: null;
  pending: true;
}

function buildAttachmentMetadata(
  contentType: string | null | undefined,
  content: any,
  messageId: string,
): PendingAttachment | null {
  const kind = mapMediaKind(contentType);
  if (kind === 'unknown') return null;
  const declaredMime = normalizeMime(content?.mimetype);
  const mime = declaredMime || (kind === 'sticker' ? 'image/webp' : 'application/octet-stream');
  const ext = inferExtension(mime);
  const sizeRaw = Number(content?.fileLength);
  return {
    kind,
    mime,
    fileName: `${messageId}_${kind}.${ext}`,
    originalFileName: content?.fileName || null,
    jpegThumbnail: extractJpegThumbnail(content),
    size: Number.isFinite(sizeRaw) && sizeRaw > 0 ? sizeRaw : 0,
    isAnimated: Boolean(content?.isAnimated),
    path: null,
    pending: true,
  };
}

async function saveMedia(
  contentType: string | null | undefined,
  content: any,
  messageId: string,
  withTimeout: WithTimeout,
  mediaDir: string = config.mediaDir,
  refresh?: { fullMessage: WAMessage; sock: Pick<WaSocketLike, 'updateMediaMessage'> },
): Promise<SavedAttachment | null> {
  const kind = mapMediaKind(contentType);
  if (kind === 'unknown') return null;
  const declaredMime = normalizeMime(content?.mimetype);
  let mime = declaredMime || (kind === 'sticker' ? 'image/webp' : 'application/octet-stream');
  let ext = inferExtension(mime);
  let filename = `${messageId}_${kind}.${ext}`;
  let filepath = path.join(mediaDir, filename);
  let usedImageFallback = false;

  // Preserve the original filename from WhatsApp (e.g. documentMessage.fileName).
  // Falls back to null for media types that don't carry a fileName.
  const originalFileName: string | null = content?.fileName || null;

  // Preserve the JPEG thumbnail for document previews (base64 for JSON transport).
  const jpegThumbnail: string | null = extractJpegThumbnail(content);

  let size: number;
  try {
    size = await downloadMediaToFile(content, kind, filepath, withTimeout, refresh);
  } catch (err) {
    if (kind !== 'sticker' || !shouldRetryStickerAsImage(err)) throw err;
    logger.warn({ err, messageId }, 'sticker decrypt failed with kind=sticker, retry as image');
    await fs.remove(filepath).catch(() => {});
    usedImageFallback = true;
    size = await downloadMediaToFile(content, 'image', filepath, withTimeout, refresh);
  }

  const shouldUseDetectedMime = !declaredMime || declaredMime === 'application/octet-stream' || usedImageFallback;
  const detectedMime = shouldUseDetectedMime ? await detectMimeFromFile(filepath) : null;
  if (detectedMime) {
    mime = detectedMime;
    ext = inferExtension(mime);
    const detectedFilename = `${messageId}_${kind}.${ext}`;
    const detectedFilepath = path.join(mediaDir, detectedFilename);
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
  buildAttachmentMetadata,
  extractJpegThumbnail,
};
