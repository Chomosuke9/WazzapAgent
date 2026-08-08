import test from 'node:test';
import assert from 'node:assert/strict';
import type { CommandContext } from '../../src/wa/command/CommandContext.ts';

process.env.LOG_LEVEL = 'silent';

const {
  downloadErrorForWhatsApp,
  handleDownload,
} = await import('../../src/wa/commands/download.ts');

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

test('/download sends the yt-dlp error detail back to WhatsApp', async () => {
  const outgoing: Array<Record<string, unknown>> = [];
  const reactions: string[] = [];
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
    sendOutgoing: async (_account, payload) => {
      outgoing.push(payload as unknown as Record<string, unknown>);
      return undefined;
    },
    wait: async () => undefined,
  });

  assert.equal(outgoing.length, 1);
  assert.equal(outgoing[0].replyTo, 'wamid-download-1');
  assert.equal(
    outgoing[0].text,
    'URL not supported.\n\nError: ERROR: Unsupported URL: [URL]',
  );
  assert.deepEqual(reactions, ['🔁', '⬇️', '❌', '']);
});

