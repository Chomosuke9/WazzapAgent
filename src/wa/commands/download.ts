import type {
  CommandContext,
  CommandHandler,
} from '../command/CommandContext.ts';

import type { AnyMessageContent } from 'baileys';

import { sendOutgoing } from '../outbound.js';

import { detectMimeFromFile } from '../../mediaHandler.js';

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import logger from '../../logger.js';

const execFileAsync = promisify(execFile);

async function downloadMedia(url: string): Promise<{
  filePath: string;
  tempDir: string;
}> {
  const tempDir = await mkdtemp(
    join(tmpdir(), 'ytdlp-'),
  );

  try {
    const { stdout } = await execFileAsync(
      'yt-dlp',
      [
        '--quiet',

        // Don't download the whole playlist.
        '--no-playlist',

        // Group best-video + best-audio formats, fall back to best.
        '--format',
        'bv*+ba/b',

        // Prefer h264/aac mp4 formats over others,
        // so the final result is most likely mp4.
        '--format-sort',
        'vcodec:h264,res,acodec:m4a',

        // Save the output to a temporary directory.
        '--output',
        join(
          tempDir,
          '%(title)s [%(id)s].%(ext)s',
        ),

        // Print the final file location after processing/merge.
        '--print',
        'after_move:filepath',

        '--no-simulate',

        // Everything after this is treated as a positional argument.
        '--',
        url,
      ],
      {
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const filePath = stdout
      .trim()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);

    if (!filePath) {
      throw new Error(
        'yt-dlp did not return an output file path.',
      );
    }

    return {
      filePath,
      tempDir,
    };
  } catch (error) {
    // If the download fails before the function finishes,
    // clean up the temporary directory right away.
    await rm(tempDir, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}


function getCommandError(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null
  ) {
    const execError = error as {
      stderr?: string | Buffer;
      message?: string;
    };

    if (execError.stderr) {
      return execError.stderr.toString();
    }

    if (execError.message) {
      return execError.message;
    }
  }

  return String(error);
}

const MAX_WHATSAPP_ERROR_LENGTH = 1_500;
const ANSI_ESCAPE_REGEX = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;

/**
 * Keep the useful yt-dlp failure detail while making it safe and compact
 * enough to send back to WhatsApp. Query strings and signed URLs are replaced
 * because they can contain credentials.
 */
export function downloadErrorForWhatsApp(
  error: unknown,
): string {
  const raw = getCommandError(error).replace(ANSI_ESCAPE_REGEX, '');
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const explicitErrors = lines.filter((line) => /^error:/i.test(line));
  const selected = explicitErrors.at(-1) ?? lines.at(-1) ?? 'Unknown error.';
  const redacted = selected.replace(URL_REGEX, '[URL]');

  if (redacted.length <= MAX_WHATSAPP_ERROR_LENGTH) return redacted;
  return `${redacted.slice(0, MAX_WHATSAPP_ERROR_LENGTH - 1)}…`;
}

function urlHostForLog(url: string): string {
  try {
    return new URL(url).host || 'unknown';
  } catch {
    return 'invalid';
  }
}

function directDownloadFileName(response: Response, requestedUrl: string): string {
  const disposition = response.headers.get('content-disposition') || '';
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  const plainName = disposition.match(/filename=([^;]+)/i)?.[1]?.trim();
  let candidate = utf8Name || quotedName || plainName || '';

  if (candidate) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      // Keep the original header value when it is not URI encoded.
    }
  } else {
    try {
      const finalUrl = new URL(response.url || requestedUrl);
      const finalSegment = finalUrl.pathname.split('/').filter(Boolean).at(-1);
      candidate = finalSegment ? decodeURIComponent(finalSegment) : '';
    } catch {
      candidate = '';
    }
  }

  const safeName = basename(candidate)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180);
  return safeName && safeName !== '.' && safeName !== '..'
    ? safeName
    : 'download';
}

export async function downloadDirectFile(url: string): Promise<{
  filePath: string;
  tempDir: string;
}> {
  const parsedUrl = new URL(url);
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error('Direct download only supports HTTP and HTTPS URLs.');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'direct-download-'));

  try {
    const response = await fetch(parsedUrl, {
      headers: {
        accept: '*/*',
        'user-agent': 'WazzapAgents/1.2',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(
        `Direct download failed with HTTP ${response.status} ${response.statusText}.`,
      );
    }
    if (!response.body) {
      throw new Error('Direct download returned an empty response body.');
    }

    const filePath = join(tempDir, directDownloadFileName(response, url));
    const source = Readable.from(
      response.body as unknown as AsyncIterable<Uint8Array>,
    );
    await pipeline(source, createWriteStream(filePath, { flags: 'wx' }));
    if ((await stat(filePath)).size === 0) {
      throw new Error('Direct download returned an empty file.');
    }

    return { filePath, tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

const SPOTDL_AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.opus',
  '.m4a',
  '.wav',
]);

function isSpotifyTrackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.toLowerCase() === 'open.spotify.com'
      && /^\/track\/[^/]+\/?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function isDrmError(errorText: string): boolean {
  const normalized = errorText.toLowerCase();
  return normalized.includes('[drm]')
    || normalized.includes('drm protection');
}

export async function downloadSpotifyMedia(url: string): Promise<{
  filePath: string;
  tempDir: string;
}> {
  if (!isSpotifyTrackUrl(url)) {
    throw new Error(
      'SpotDL fallback only supports individual open.spotify.com track URLs.',
    );
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'spotdl-'));

  try {
    await execFileAsync(
      'spotdl',
      [
        'download',
        '--format',
        'mp3',
        '--output',
        join(tempDir, '{artists} - {title}.{output-ext}'),
        '--restrict',
        'ascii',
        '--simple-tui',
        '--print-errors',
        '--log-level',
        'ERROR',
        url,
      ],
      {
        cwd: tempDir,
        maxBuffer: 10 * 1024 * 1024,
      },
    );

    const entries = await readdir(tempDir, { withFileTypes: true });
    const audioFiles = entries.filter((entry) => {
      if (!entry.isFile()) return false;
      const extension = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      return SPOTDL_AUDIO_EXTENSIONS.has(extension);
    });
    if (audioFiles.length !== 1) {
      throw new Error(
        `SpotDL produced ${audioFiles.length} audio files; expected exactly one.`,
      );
    }

    const filePath = join(tempDir, audioFiles[0].name);
    if ((await stat(filePath)).size === 0) {
      throw new Error('SpotDL returned an empty audio file.');
    }

    return { filePath, tempDir };
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

interface DownloadCommandDeps {
  downloadMedia: typeof downloadMedia;
  downloadDirectFile: typeof downloadDirectFile;
  downloadSpotifyMedia: typeof downloadSpotifyMedia;
  sendOutgoing: typeof sendOutgoing;
  wait: (milliseconds: number) => Promise<void>;
}


// WhatsApp renders attachments based on the message content type (image/video/
// audio/document), not the mimetype. Map the sniffed mime to the narrow set of
// media kinds WhatsApp plays inline; anything else falls back to `document`.
const WA_INLINE_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);
const WA_INLINE_VIDEO_MIMES = new Set(['video/mp4']);
const WA_INLINE_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/opus',
]);

function mediaKindForMime(
  mime: string | null,
): 'image' | 'video' | 'audio' | 'document' {
  if (mime && WA_INLINE_IMAGE_MIMES.has(mime)) return 'image';
  if (mime && WA_INLINE_VIDEO_MIMES.has(mime)) return 'video';
  if (mime && WA_INLINE_AUDIO_MIMES.has(mime)) return 'audio';
  return 'document';
}


export async function handleDownload(
  {
    chatId,
    sock,
    account,
    args,
    msg,
  }: CommandContext,
  dependencies: Partial<DownloadCommandDeps> = {},
): Promise<void> {
  const runDownload = dependencies.downloadMedia ?? downloadMedia;
  const runDirectDownload = dependencies.downloadDirectFile ?? downloadDirectFile;
  const runSpotifyDownload = dependencies.downloadSpotifyMedia
    ?? downloadSpotifyMedia;
  const sendReply = dependencies.sendOutgoing ?? sendOutgoing;
  const wait = dependencies.wait ?? (
    (milliseconds: number) => new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    })
  );

  const reactWithProgress = async (emoji: string): Promise<void> => {
    try {
      await sock.sendMessage(chatId, { react: { text: emoji, key: msg!.key } });
    } catch (err) {
      logger.warn(
        { err, chatId, emoji },
        'download: failed to update progress reaction',
      );
    }
  };

  const urlRegex = /https?:\/\/[^\s<>"'`]+/g;

  const matches = args.match(urlRegex);

  if (!matches) {
    logger.warn({ chatId }, 'download: no URL provided');
    try {
      await sendReply(account!, {
        chatId,
        replyTo: msg!.key.id as string,
        text: 'No URL provided.',
      });
    } catch (err) {
      logger.error({ err, chatId }, 'download: failed to send missing-URL response');
    }

    return;
  }

  await reactWithProgress('🔁');

  const url = matches[0];
  const urlHost = urlHostForLog(url);
  const startedAt = Date.now();

  logger.info({ chatId, urlHost }, 'download: started');

  let tempDir: string | undefined;
  let source: 'yt-dlp' | 'direct' | 'spotdl' = 'yt-dlp';

  try {
    await reactWithProgress('⬇️');
    let result: Awaited<ReturnType<typeof downloadMedia>>;
    try {
      result = await runDownload(url);
    } catch (ytDlpError) {
      const rawYtDlpError = getCommandError(ytDlpError).toLowerCase();
      const errorContext = {
        chatId,
        urlHost,
        errorMessage: downloadErrorForWhatsApp(ytDlpError),
      };

      if (rawYtDlpError.includes('unsupported url')) {
        source = 'direct';
        logger.warn(
          errorContext,
          'download: yt-dlp does not support URL; trying direct download',
        );
        result = await runDirectDownload(url);
      } else if (isDrmError(rawYtDlpError) && isSpotifyTrackUrl(url)) {
        source = 'spotdl';
        logger.warn(
          errorContext,
          'download: yt-dlp reported Spotify DRM; trying SpotDL',
        );
        result = await runSpotifyDownload(url);
      } else {
        throw ytDlpError;
      }
    }

    tempDir = result.tempDir;
    const sniffed = await detectMimeFromFile(result.filePath);
    const mime = sniffed || 'application/octet-stream';
    const kind = mediaKindForMime(sniffed);
    const content: Record<string, unknown> = {
      fileName: basename(result.filePath),
      mimetype: mime,
    };
    if (kind === 'image') content.image = { url: result.filePath };
    else if (kind === 'video') content.video = { url: result.filePath };
    else if (kind === 'audio') content.audio = { url: result.filePath, ptt: false };
    else content.document = { url: result.filePath };

    logger.info(
      {
        chatId,
        urlHost,
        fileName: basename(result.filePath),
        mime,
        kind,
        source,
      },
      'download: media ready to send',
    );

    await reactWithProgress('⬆️');
    await sock.sendMessage(
      chatId,
      content as AnyMessageContent,
      {
        quoted: msg,
      },
    );
    await reactWithProgress('✅');
    logger.info(
      { chatId, urlHost, source, durationMs: Date.now() - startedAt },
      'download: completed',
    );
  } catch (error) {
    const rawError = getCommandError(error);
    const errorMessage = downloadErrorForWhatsApp(error);
    const unsupported = rawError.toLowerCase().includes('unsupported url');
    await reactWithProgress('❌');

    logger.error(
      {
        chatId,
        urlHost,
        errorMessage,
        errorType: error instanceof Error ? error.name : typeof error,
        durationMs: Date.now() - startedAt,
      },
      'download: failed',
    );

    const summary = unsupported
      ? 'URL not supported.'
      : 'Failed to download media.';

    try {
      await sendReply(account!, {
        chatId,
        replyTo: msg!.key.id as string,
        text: `${summary}\n\nError: ${errorMessage}`,
      });
    } catch (replyError) {
      logger.error(
        { err: replyError, chatId, urlHost },
        'download: failed to send error response to WhatsApp',
      );
    }
  } finally {
    // The file is removed once it has been sent.
    if (tempDir) {
      try {
        await rm(tempDir, {
          recursive: true,
          force: true,
        });
      } catch (err) {
        logger.warn(
          { err, chatId, tempDir },
          'download: failed to clean temporary files',
        );
      }
    }
    await wait(5000);
    await reactWithProgress('');
  }
}


export const downloadCommand: CommandHandler = {
  commands: ['download', 'dl'],

  description:
    'Downloads a file from the specified URL.',

  permission: 'public',

  run: (_sock, _message, ctx) =>
    handleDownload(ctx),
};
