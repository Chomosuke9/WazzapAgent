import type {
  CommandContext,
  CommandHandler,
} from '../command/CommandContext.ts';

import type { AnyMessageContent } from 'baileys';

import { sendOutgoing } from '../outbound.js';

import { detectMimeFromFile } from '../../mediaHandler.js';

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const execFileAsync = promisify(execFile);

import logger from '../../logger.js';




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

        // Jangan download seluruh playlist.
        '--no-playlist',

        // Kualitas terbaik yang tersedia.
        '--format',
        'bv*+ba/b',

        // Simpan hasil ke temporary directory.
        '--output',
        join(
          tempDir,
          '%(title)s [%(id)s].%(ext)s',
        ),

        // Print lokasi file final setelah processing/merge.
        '--print',
        'after_move:filepath',

        '--no-simulate',

        // Semua argument setelah ini dianggap positional argument.
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
    // Kalau download gagal sebelum fungsi selesai,
    // langsung bersihkan temporary directory.
    await rm(tempDir, {
      recursive: true,
      force: true,
    });

    throw error;
  }
}


function getYtDlpError(error: unknown): string {
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


async function handleDownload({
  chatId,
  sock,
  account,
  args,
  msg,
}: CommandContext): Promise<void> {
  const reactWithProgress = async (emoji: string): Promise<void> => {
    try {
      await sock.sendMessage(chatId, { react: { text: emoji, key: msg!.key } });
    } catch (err) {
      logger.warn({ err, chatId, emoji }, 'failed to update sticker progress reaction');
    }
  };
  await reactWithProgress('🔁');

  const urlRegex = /https?:\/\/[^\s<>"'`]+/g;

  const matches = args.match(urlRegex);

  if (!matches) {
    await sendOutgoing(account!, {
      chatId,
      replyTo: msg!.key.id as string,
      text: 'No URL provided.',
    });

    return;
  }

  const url = matches[0];

  let tempDir: string | undefined;

  try {
    await reactWithProgress('⬇️');
    const result = await downloadMedia(url);

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

    await reactWithProgress('⬆️');
    await sock.sendMessage(
      chatId,
      content as AnyMessageContent,
      {
        quoted: msg,
      },
    );
    await reactWithProgress('✅');
  } catch (error) {
    const errorMessage = getYtDlpError(error);
    await reactWithProgress('❌');

    console.error(
      'yt-dlp download failed:',
      errorMessage,
    );

    if (
      errorMessage
        .toLowerCase()
        .includes('unsupported url')
    ) {
      await sendOutgoing(account!, {
        chatId,
        replyTo: msg!.key.id as string,
        text: 'URL not supported.',
      });

      return;
    }

    await sendOutgoing(account!, {
      chatId,
      replyTo: msg!.key.id as string,
      text: 'Failed to download media.',
    });
  } finally {
    // File baru dihapus setelah selesai dikirim.
    if (tempDir) {
      await rm(tempDir, {
        recursive: true,
        force: true,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
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
