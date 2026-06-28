import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import fs from 'fs-extra';

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

  await pipeline(source, fs.createWriteStream(filepath));
  return (await fs.stat(filepath)).size;
}

export default {
  streamToFile,
};
