import { finished, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';
import fs from 'fs-extra';
import logger from '../logger.js';

const streamFinished = promisify(finished);

function chunkSize(chunk) {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

export async function streamToBuffer(stream) {
  const chunks = [];

  // Handle AsyncIterable (Baileys media stream)
  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  // Fallback: Node.js stream
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== 'function') {
      return reject(new Error('Invalid stream'));
    }
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', (err) => {
      logger.error({ err }, 'stream error');
      reject(err);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    streamFinished(stream).catch(reject);
  });
}

export async function streamToFile(stream, filepath) {
  if (!filepath || typeof filepath !== 'string') {
    throw new Error('Invalid filepath');
  }

  let size = 0;

  if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
    const iterable = (async function* collect() {
      for await (const chunk of stream) {
        size += chunkSize(chunk);
        yield chunk;
      }
    }());
    await pipeline(Readable.from(iterable), fs.createWriteStream(filepath));
    return size;
  }

  if (!stream || typeof stream.pipe !== 'function') {
    throw new Error('Invalid stream');
  }

  stream.on('data', (chunk) => {
    size += chunkSize(chunk);
  });
  await pipeline(stream, fs.createWriteStream(filepath));
  return size;
}

export default {
  streamToBuffer,
  streamToFile,
};