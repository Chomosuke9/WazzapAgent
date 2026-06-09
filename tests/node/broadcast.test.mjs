// Set env vars BEFORE any import of src/* (config.js and logger.js read env at import time)
process.env.LOG_LEVEL = 'info';
process.env.LLM_WS_ENDPOINT = 'ws://127.0.0.1:1/ws';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const { reconstructAndSend } = await import('../../src/wa/command/broadcast.js');

// Helper to build a mock sock with call tracking
const makeSock = () => {
  const calls = { sendMessage: [], relayMessage: [] };
  return {
    user: { id: 'bot@s.whatsapp.net' },
    sendMessage: async (...args) => { calls.sendMessage.push(args); },
    relayMessage: async (...args) => { calls.relayMessage.push(args); },
    _calls: calls
  };
};

describe('reconstructAndSend', () => {
  it('invite link with thumbnail builds correct linkPreview', async () => {
    const sock = makeSock();
    const ext = {
      text: 'https://chat.whatsapp.com/abc',
      matchedText: 'https://chat.whatsapp.com/abc',
      jpegThumbnail: 'base64data',
      thumbnailDirectPath: '/v/test',
      mediaKey: 'a2V5',
      thumbnailSha256: 'c2hh',
      thumbnailEncSha256: 'ZW5j',
      mediaKeyTimestamp: '12345',
      thumbnailWidth: 640,
      thumbnailHeight: 640
    };
    const cachedMsg = { message: { extendedTextMessage: ext } };

    const result = await reconstructAndSend(sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, true);
    assert.equal(sock._calls.sendMessage.length, 1);
    assert.equal(sock._calls.relayMessage.length, 0);

    const [, content] = sock._calls.sendMessage[0];
    assert.ok(content.linkPreview, 'linkPreview should be set');
    assert.equal(content.linkPreview['matched-text'], 'https://chat.whatsapp.com/abc');
    assert.ok(content.linkPreview.highQualityThumbnail, 'highQualityThumbnail should be set');
    assert.equal(content.linkPreview.highQualityThumbnail.directPath, '/v/test');
    assert.ok(Buffer.isBuffer(content.linkPreview.highQualityThumbnail.fileSha256), 'fileSha256 should be a Buffer');
    assert.ok(Buffer.isBuffer(content.linkPreview.highQualityThumbnail.fileEncSha256), 'fileEncSha256 should be a Buffer');
    assert.equal(content.linkPreview.highQualityThumbnail.mediaKeyTimestamp, 12345);
    assert.equal(content.linkPreview.highQualityThumbnail.width, 640);
    assert.equal(content.linkPreview.highQualityThumbnail.height, 640);
  });

  it('newsletter forward uses relayMessage', async () => {
    const sock = makeSock();
    const ext = {
      text: 'hello',
      previewType: 'NONE',
      contextInfo: {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: '123@newsletter',
          serverMessageId: 1,
          newsletterName: 'Test'
        }
      },
      inviteLinkGroupTypeV2: 'DEFAULT'
    };
    const cachedMsg = { message: { extendedTextMessage: ext } };

    const result = await reconstructAndSend(sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, true);
    assert.equal(sock._calls.relayMessage.length, 1, 'relayMessage should be called once');
    assert.equal(sock._calls.sendMessage.length, 0, 'sendMessage should not be called');

    const [relayJid, relayPayload] = sock._calls.relayMessage[0];
    assert.equal(relayJid, 'target@g.us');
    const etm = relayPayload?.extendedTextMessage;
    assert.ok(etm, 'relayed payload must contain extendedTextMessage');
    assert.ok(etm?.contextInfo?.forwardedNewsletterMessageInfo, 'forwardedNewsletterMessageInfo must be preserved');
    assert.equal(etm.contextInfo.forwardedNewsletterMessageInfo.newsletterJid, '123@newsletter');
    assert.equal(etm.contextInfo.forwardedNewsletterMessageInfo.newsletterName, 'Test');
  });

  it('plain text uses sendMessage with text', async () => {
    const sock = makeSock();
    const cachedMsg = { message: { conversation: 'hello' } };

    const result = await reconstructAndSend(sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, true);
    assert.equal(sock._calls.sendMessage.length, 1);
    assert.equal(sock._calls.relayMessage.length, 0);

    const [, content] = sock._calls.sendMessage[0];
    assert.equal(content.text, 'hello');
  });

  it('canonicalUrl path sets linkPreview with matched-text', async () => {
    const sock = makeSock();
    const ext = {
      text: 'https://example.com',
      canonicalUrl: 'https://example.com',
      matchedText: 'https://example.com',
      title: 'Ex'
    };
    const cachedMsg = { message: { extendedTextMessage: ext } };

    const result = await reconstructAndSend(sock, 'target@g.us', cachedMsg);

    assert.equal(result.ok, true);
    assert.equal(sock._calls.sendMessage.length, 1);
    assert.equal(sock._calls.relayMessage.length, 0);

    const [, content] = sock._calls.sendMessage[0];
    assert.ok(content.linkPreview, 'linkPreview should be set');
    assert.equal(content.linkPreview['matched-text'], 'https://example.com');
  });
});
