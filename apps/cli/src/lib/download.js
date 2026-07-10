import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export async function downloadArtifact(artifact, destinationDirectory, signal) {
  await mkdir(destinationDirectory, { recursive: true });
  const destinationPath = path.join(destinationDirectory, artifact.fileName);
  const temporaryPath = `${destinationPath}.partial`;
  let offset = 0;
  try { offset = (await stat(temporaryPath)).size; } catch {}
  const headers = { ...artifact.headers };
  if (offset > 0) headers.Range = `bytes=${offset}-`;
  const response = await fetch(artifact.url, { headers, signal, redirect: 'follow' });
  if (!response.ok && response.status !== 206) throw new Error(`Download failed with HTTP ${response.status} for ${artifact.url}`);
  if (!response.body) throw new Error(`Download returned no body for ${artifact.url}`);
  const append = response.status === 206 && offset > 0;
  if (!append) {
    offset = 0;
    await rm(temporaryPath, { force: true });
  }
  let received = offset;
  let lastPrinted = 0;
  const progress = new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (Date.now() - lastPrinted > 500) {
        process.stderr.write(`\rDownloading ${artifact.fileName}: ${(received / 1024 / 1024).toFixed(1)} MiB`);
        lastPrinted = Date.now();
      }
      callback(null, chunk);
    }
  });
  await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporaryPath, { flags: append ? 'a' : 'w' }));
  process.stderr.write(`\rDownloading ${artifact.fileName}: ${(received / 1024 / 1024).toFixed(1)} MiB\n`);
  if (artifact.sha256) {
    const digest = await hashFile(temporaryPath);
    if (digest !== artifact.sha256) {
      await rm(temporaryPath, { force: true });
      throw new Error(`SHA-256 mismatch for ${artifact.fileName}.`);
    }
  }
  await rename(temporaryPath, destinationPath);
  return destinationPath;
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
