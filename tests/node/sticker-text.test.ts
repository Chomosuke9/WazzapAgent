import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { stickerTextInternals } from '../../src/wa/commands/sticker.js';

const {
  buildTextOverlaySvg,
  containImageBounds,
  createStickerFile,
  fitFontSize,
  stickerMediaCandidate,
} = stickerTextInternals;

test('sticker text uses a smaller maximum font size', () => {
  assert.equal(fitFontSize('HI', 472, 512), 51);
});

test('long sticker text is constrained inside the canvas', () => {
  const svg = buildTextOverlaySvg(
    512,
    'THIS IS AN EXTREMELY LONG LINE THAT MUST NOT ESCAPE THE STICKER',
    null,
  )!.toString('utf8');

  const textLength = Number(svg.match(/textLength="(\d+)"/)?.[1]);
  const strokeWidth = Number(svg.match(/stroke-width="(\d+)"/)?.[1]);
  const padding = Math.round(512 * 0.04);

  assert.ok(textLength > 0);
  assert.ok(textLength + strokeWidth * 2 <= 512 - padding * 2);
  assert.match(svg, /lengthAdjust="spacingAndGlyphs"/);
});

test('sticker text remains XML-safe', () => {
  const svg = buildTextOverlaySvg(512, '<HELLO & "GOODBYE">', null)!.toString('utf8');

  assert.match(svg, /&lt;HELLO &amp; &quot;GOODBYE&quot;&gt;/);
});

test('contain bounds handle tiny, extreme, and very large resolutions', () => {
  assert.deepEqual(containImageBounds(2, 2, 512), { left: 0, top: 0, width: 512, height: 512 });
  assert.deepEqual(containImageBounds(600, 100, 512), { left: 0, top: 213, width: 512, height: 85 });
  assert.deepEqual(containImageBounds(100, 600, 512), { left: 213, top: 0, width: 85, height: 512 });
  assert.deepEqual(containImageBounds(12000, 8000, 512), { left: 0, top: 85, width: 512, height: 341 });
});

test('text follows the visible image bounds for 6:1 and 1:6 inputs', () => {
  for (const bounds of [containImageBounds(600, 100, 512), containImageBounds(100, 600, 512)]) {
    const svg = buildTextOverlaySvg(512, 'TOP TEXT', 'BOTTOM TEXT', bounds)!.toString('utf8');
    const textLengths = [...svg.matchAll(/textLength="(\d+)"/g)].map((match) => Number(match[1]));
    const strokeWidths = [...svg.matchAll(/stroke-width="(\d+)"/g)].map((match) => Number(match[1]));
    const xPositions = [...svg.matchAll(/<text x="([\d.]+)"/g)].map((match) => Number(match[1]));

    assert.equal(textLengths.length, 2);
    assert.ok(textLengths.every((length, index) => length + strokeWidths[index] * 2 <= bounds.width));
    assert.ok(xPositions.every((x) => x === bounds.left + bounds.width / 2));
  }
});

test('real sticker conversion handles tiny, extreme-ratio, and large images', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sticker-text-edge-'));
  const cases = [
    { name: 'tiny', width: 2, height: 2 },
    { name: 'wide', width: 600, height: 100 },
    { name: 'tall', width: 100, height: 600 },
    { name: 'large', width: 4096, height: 3072 },
  ];

  try {
    for (const imageCase of cases) {
      const inputPath = path.join(tempDir, `${imageCase.name}.png`);
      await sharp({
        create: {
          width: imageCase.width,
          height: imageCase.height,
          channels: 4,
          background: { r: 40, g: 120, b: 200, alpha: 1 },
        },
      }).png().toFile(inputPath);

      const outputPath = await createStickerFile(inputPath, 'TOP TEXT', 'BOTTOM TEXT', tempDir);
      // Read first so Sharp never retains a Windows handle to the output path.
      const metadata = await sharp(await readFile(outputPath)).metadata();
      assert.equal(metadata.format, 'webp', imageCase.name);
      assert.equal(metadata.width, 512, imageCase.name);
      assert.equal(metadata.height, 512, imageCase.name);
    }
  } finally {
    // Native Sharp/webpmux handles can be released a moment later on Windows.
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('replying to a static sticker selects the WebP image pipeline', () => {
  const content = { mimetype: 'image/webp', isAnimated: false } as never;

  assert.deepEqual(stickerMediaCandidate('stickerMessage', { stickerMessage: content }), {
    content,
    contentType: 'stickerMessage',
    isAnimated: false,
  });
});

test('an existing static WebP sticker can be converted with new text', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'sticker-reply-webp-'));
  try {
    const inputPath = path.join(tempDir, 'replied-sticker.webp');
    await sharp({
      create: {
        width: 512,
        height: 512,
        channels: 4,
        background: { r: 70, g: 40, b: 150, alpha: 1 },
      },
    }).webp().toFile(inputPath);

    const outputPath = await createStickerFile(inputPath, 'NEW TOP', 'NEW BOTTOM', tempDir);
    const metadata = await sharp(await readFile(outputPath)).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 512);
  } finally {
    await rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test('replying to an animated sticker selects the animated pipeline', () => {
  const content = { mimetype: 'image/webp', isAnimated: true } as never;

  assert.deepEqual(stickerMediaCandidate('stickerMessage', { stickerMessage: content }), {
    content,
    contentType: 'stickerMessage',
    isAnimated: true,
  });
});
