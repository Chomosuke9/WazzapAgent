import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CommandContext } from '../../src/wa/command/CommandContext.ts';

process.env.LOG_LEVEL = 'silent';

const {
  buildSpotDlInvocation,
  downloadDirectFile,
  downloadErrorForWhatsApp,
  handleDownload,
} = await import('../../src/wa/commands/download.ts');

test('SpotDL runs through the selected bridge Python, not a spotdl shim', () => {
  const invocation = buildSpotDlInvocation(
    'https://open.spotify.com/track/track-id',
    '/tmp/spotdl-test',
    '/runtime/python3',
  );

  assert.equal(invocation.file, '/runtime/python3');
  assert.deepEqual(invocation.args.slice(0, 4), [
    '-m',
    'spotdl',
    'download',
    'https://open.spotify.com/track/track-id',
  ]);
  assert.equal(invocation.args.at(-1), 'ERROR');
  assert.notEqual(invocation.file, 'spotdl');
});

test('/download selects the final yt-dlp error and redacts URLs', () => {
  const detail = downloadErrorForWhatsApp({
    stderr: [
      'WARNING: retrying',
      'ERROR: first failure',
      'ERROR: signed media URL failed: https://example.com/video?token=secret',
    ].join('\n'),
  });

  assert.equal(detail, 'ERROR: signed media URL failed: [URL]');
  assert.doesNotMatch(detail, /secret/);
});

test('direct download streams an HTTP response into a temporary file', async () => {
  const body = Buffer.from('%PDF-direct-download-test');
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-disposition': "attachment; filename*=UTF-8''sample%20file.pdf",
      'content-type': 'application/pdf',
    });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let tempDir: string | undefined;
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const result = await downloadDirectFile(
      `http://127.0.0.1:${address.port}/original-name`,
    );
    tempDir = result.tempDir;

    assert.equal(result.filePath, join(result.tempDir, 'sample file.pdf'));
    assert.deepEqual(await readFile(result.filePath), body);
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test('/download falls back to a direct download for unsupported URLs', async () => {
  const outgoing: Array<Record<string, unknown>> = [];
  const reactions: string[] = [];
  const mediaMessages: Array<Record<string, unknown>> = [];
  let directDownloadCalls = 0;
  const ctx = {
    chatId: '123@g.us',
    args: 'https://unsupported.example/video',
    account: {},
    msg: { key: { id: 'wamid-download-1' } },
    sock: {
      sendMessage: async (
        _chatId: string,
        content: { react?: { text: string } },
      ) => {
        if (content.react) reactions.push(content.react.text);
        else mediaMessages.push(content as unknown as Record<string, unknown>);
        return undefined;
      },
    },
  } as unknown as CommandContext;

  await handleDownload(ctx, {
    downloadMedia: async () => {
      throw {
        stderr: 'ERROR: Unsupported URL: https://unsupported.example/video?token=secret',
      };
    },
    downloadDirectFile: async () => {
      directDownloadCalls++;
      const tempDir = await mkdtemp(join(tmpdir(), 'download-fallback-test-'));
      const filePath = join(tempDir, 'fallback.mp4');
      await writeFile(filePath, Buffer.from([
        0x00, 0x00, 0x00, 0x18,
        0x66, 0x74, 0x79, 0x70,
        0x6d, 0x70, 0x34, 0x32,
      ]));
      return { filePath, tempDir };
    },
    sendOutgoing: async (_account, payload) => {
      outgoing.push(payload as unknown as Record<string, unknown>);
      return undefined;
    },
    wait: async () => undefined,
  });

  assert.equal(directDownloadCalls, 1);
  assert.equal(outgoing.length, 0);
  assert.equal(mediaMessages.length, 1);
  assert.equal(mediaMessages[0].fileName, 'fallback.mp4');
  assert.equal(mediaMessages[0].mimetype, 'video/mp4');
  assert.ok(mediaMessages[0].video);
  assert.deepEqual(reactions, ['🔁', '⬇️', '⬆️', '✅', '']);
});

test('/download preserves ZIP MIME from the filename when magic sniffing is inconclusive', async () => {
  const mediaMessages: Array<Record<string, unknown>> = [];
  const ctx = {
    chatId: '123@g.us',
    args: 'https://example.com/archive.zip',
    account: {},
    msg: { key: { id: 'wamid-download-zip' } },
    sock: {
      sendMessage: async (
        _chatId: string,
        content: { react?: { text: string } },
      ) => {
        if (!content.react) {
          mediaMessages.push(content as unknown as Record<string, unknown>);
        }
        return undefined;
      },
    },
  } as unknown as CommandContext;

  await handleDownload(ctx, {
    downloadMedia: async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'download-zip-test-'));
      const filePath = join(tempDir, 'archive.zip');
      // Deliberately omit a recognizable ZIP header to exercise the filename
      // fallback instead of magic-byte sniffing.
      await writeFile(filePath, Buffer.from('opaque-archive-payload'));
      return { filePath, tempDir };
    },
    wait: async () => undefined,
  });

  assert.equal(mediaMessages.length, 1);
  assert.equal(mediaMessages[0].fileName, 'archive.zip');
  assert.equal(mediaMessages[0].mimetype, 'application/zip');
  assert.ok(mediaMessages[0].document);
});

test('/download adds a ZIP extension when only the file signature identifies it', async () => {
  const mediaMessages: Array<Record<string, unknown>> = [];
  const ctx = {
    chatId: '123@g.us',
    args: 'https://example.com/download',
    account: {},
    msg: { key: { id: 'wamid-download-extensionless-zip' } },
    sock: {
      sendMessage: async (
        _chatId: string,
        content: { react?: { text: string } },
      ) => {
        if (!content.react) {
          mediaMessages.push(content as unknown as Record<string, unknown>);
        }
        return undefined;
      },
    },
  } as unknown as CommandContext;

  await handleDownload(ctx, {
    downloadMedia: async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'download-extensionless-zip-test-'));
      const filePath = join(tempDir, 'download');
      await writeFile(filePath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]));
      return { filePath, tempDir };
    },
    wait: async () => undefined,
  });

  assert.equal(mediaMessages.length, 1);
  assert.equal(mediaMessages[0].fileName, 'download.zip');
  assert.equal(mediaMessages[0].mimetype, 'application/zip');
  assert.ok(mediaMessages[0].document);
});

test('/download does not use the direct fallback for other yt-dlp errors', async () => {
  const outgoing: Array<Record<string, unknown>> = [];
  let directDownloadCalls = 0;
  const ctx = {
    chatId: '123@g.us',
    args: 'https://example.com/video',
    account: {},
    msg: { key: { id: 'wamid-download-2' } },
    sock: {
      sendMessage: async () => undefined,
    },
  } as unknown as CommandContext;

  await handleDownload(ctx, {
    downloadMedia: async () => {
      throw { stderr: 'ERROR: Network connection timed out.' };
    },
    downloadDirectFile: async () => {
      directDownloadCalls++;
      throw new Error('Direct fallback should not run.');
    },
    sendOutgoing: async (_account, payload) => {
      outgoing.push(payload as unknown as Record<string, unknown>);
      return undefined;
    },
    wait: async () => undefined,
  });

  assert.equal(directDownloadCalls, 0);
  assert.equal(outgoing.length, 1);
  assert.equal(
    outgoing[0].text,
    'Failed to download media.\n\nError: ERROR: Network connection timed out.',
  );
});

test('/download uses SpotDL for a Spotify track rejected as DRM', async () => {
  const outgoing: Array<Record<string, unknown>> = [];
  const mediaMessages: Array<Record<string, unknown>> = [];
  let directDownloadCalls = 0;
  let spotifyDownloadCalls = 0;
  const spotifyUrl = 'https://open.spotify.com/track/spotify-track-id?si=abc';
  const ctx = {
    chatId: '123@g.us',
    args: spotifyUrl,
    account: {},
    msg: { key: { id: 'wamid-download-3' } },
    sock: {
      sendMessage: async (
        _chatId: string,
        content: { react?: { text: string } },
      ) => {
        if (!content.react) {
          mediaMessages.push(content as unknown as Record<string, unknown>);
        }
        return undefined;
      },
    },
  } as unknown as CommandContext;

  await handleDownload(ctx, {
    downloadMedia: async () => {
      throw {
        stderr: [
          'ERROR: [DRM] The requested site is known to use DRM protection.',
          'Please DO NOT open an issue.',
        ].join('\n'),
      };
    },
    downloadDirectFile: async () => {
      directDownloadCalls++;
      throw new Error('Direct fallback should not run.');
    },
    downloadSpotifyMedia: async (url) => {
      assert.equal(url, spotifyUrl);
      spotifyDownloadCalls++;
      const tempDir = await mkdtemp(join(tmpdir(), 'download-spotdl-test-'));
      const filePath = join(tempDir, 'Artist - Track.mp3');
      await writeFile(filePath, Buffer.from('ID3-test-audio'));
      return { filePath, tempDir };
    },
    sendOutgoing: async (_account, payload) => {
      outgoing.push(payload as unknown as Record<string, unknown>);
      return undefined;
    },
    wait: async () => undefined,
  });

  assert.equal(directDownloadCalls, 0);
  assert.equal(spotifyDownloadCalls, 1);
  assert.equal(outgoing.length, 0);
  assert.equal(mediaMessages.length, 1);
  assert.equal(mediaMessages[0].fileName, 'Artist - Track.mp3');
  assert.equal(mediaMessages[0].mimetype, 'audio/mpeg');
  assert.ok(mediaMessages[0].audio);
});

test('/download does not use SpotDL for DRM errors from non-Spotify sites', async () => {
  const outgoing: Array<Record<string, unknown>> = [];
  let spotifyDownloadCalls = 0;
  const ctx = {
    chatId: '123@g.us',
    args: 'https://drm.example/video',
    account: {},
    msg: { key: { id: 'wamid-download-4' } },
    sock: { sendMessage: async () => undefined },
  } as unknown as CommandContext;

  await handleDownload(ctx, {
    downloadMedia: async () => {
      throw { stderr: 'ERROR: [DRM] This site uses DRM protection.' };
    },
    downloadSpotifyMedia: async () => {
      spotifyDownloadCalls++;
      throw new Error('SpotDL should not run.');
    },
    sendOutgoing: async (_account, payload) => {
      outgoing.push(payload as unknown as Record<string, unknown>);
      return undefined;
    },
    wait: async () => undefined,
  });

  assert.equal(spotifyDownloadCalls, 0);
  assert.equal(outgoing.length, 1);
  assert.match(String(outgoing[0].text), /DRM protection/);
});
