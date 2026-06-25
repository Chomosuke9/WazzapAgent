import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import fs from 'fs-extra';

function chunkSize(chunk: unknown): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk)) return chunk.length;
  if (ArrayBuffer.isView(chunk)) return chunk.byteLength;
  if (chunk instanceof ArrayBuffer) return chunk.byteLength;
  return 0;
}

export async function streamToFile(stream: any, filepath: string): Promise<number> {
  if (!filepath || typeof filepath !== 'string') {
    throw new Error('Invalid filepath');
  }

  const source = stream && typeof stream[Symbol.asyncIterator] === 'function'
    ? Readable.from(stream)
    : stream;

  if (!source || typeof source.pipe !== 'function') {
    throw new Error('Invalid stream');
  }

  let size = 0;
  const counting = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunkSize(chunk);
      callback(null, chunk);
    }
  });

  await pipeline(source, counting, fs.createWriteStream(filepath));
  return size;
}

export default {
  streamToFile,
};
