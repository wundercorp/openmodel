import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';

export async function downloadArtifact(artifact, destinationDirectory, options = {}) {
  const normalizedOptions = normalizeDownloadOptions(options);
  const signal = normalizedOptions.signal;
  const onProgress = normalizedOptions.onProgress;
  await mkdir(destinationDirectory, { recursive: true });
  const destinationPath = path.join(destinationDirectory, artifact.fileName);
  const temporaryPath = `${destinationPath}.partial`;
  let offset = 0;
  try {
    offset = (await stat(temporaryPath)).size;
  } catch {}

  const headers = { ...artifact.headers };
  if (offset > 0) {
    headers.Range = `bytes=${offset}-`;
  }

  const response = await fetch(artifact.url, { headers, signal, redirect: 'follow' });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Download failed with HTTP ${response.status} for ${artifact.url}`);
  }
  if (!response.body) {
    throw new Error(`Download returned no body for ${artifact.url}`);
  }

  const append = response.status === 206 && offset > 0;
  if (!append) {
    offset = 0;
    await rm(temporaryPath, { force: true });
  }

  const totalBytes = readTotalBytes(response, offset);
  let receivedBytes = offset;
  let lastReportedAt = 0;
  reportProgress(onProgress, {
    type: 'download-start',
    fileName: artifact.fileName,
    receivedBytes,
    totalBytes,
    progress: calculateProgress(receivedBytes, totalBytes),
    message: `Downloading ${artifact.fileName}.`
  });

  const progressTransform = new Transform({
    transform(chunk, encoding, callback) {
      receivedBytes += chunk.length;
      const currentTime = Date.now();
      if (currentTime - lastReportedAt >= 150) {
        reportProgress(onProgress, {
          type: 'download-progress',
          fileName: artifact.fileName,
          receivedBytes,
          totalBytes,
          progress: calculateProgress(receivedBytes, totalBytes),
          message: `Downloading ${artifact.fileName}.`
        });
        if (!onProgress) {
          process.stderr.write(`\rDownloading ${artifact.fileName}: ${(receivedBytes / 1024 / 1024).toFixed(1)} MiB`);
        }
        lastReportedAt = currentTime;
      }
      callback(null, chunk);
    }
  });

  await pipeline(
    Readable.fromWeb(response.body),
    progressTransform,
    createWriteStream(temporaryPath, { flags: append ? 'a' : 'w' })
  );

  if (!onProgress) {
    process.stderr.write(`\rDownloading ${artifact.fileName}: ${(receivedBytes / 1024 / 1024).toFixed(1)} MiB\n`);
  }

  reportProgress(onProgress, {
    type: 'download-complete',
    fileName: artifact.fileName,
    receivedBytes,
    totalBytes: totalBytes ?? receivedBytes,
    progress: 100,
    message: `Downloaded ${artifact.fileName}.`
  });

  if (artifact.sha256) {
    reportProgress(onProgress, {
      type: 'verifying',
      fileName: artifact.fileName,
      receivedBytes,
      totalBytes: totalBytes ?? receivedBytes,
      progress: 100,
      message: `Verifying ${artifact.fileName}.`
    });
    const digest = await hashFile(temporaryPath);
    if (digest !== artifact.sha256) {
      await rm(temporaryPath, { force: true });
      throw new Error(`SHA-256 mismatch for ${artifact.fileName}.`);
    }
  }

  await rename(temporaryPath, destinationPath);
  return destinationPath;
}

function normalizeDownloadOptions(options) {
  if (
    options &&
    typeof options === 'object' &&
    typeof options.aborted === 'boolean' &&
    typeof options.addEventListener === 'function'
  ) {
    return { signal: options, onProgress: undefined };
  }

  return {
    signal: options?.signal,
    onProgress: typeof options?.onProgress === 'function' ? options.onProgress : undefined
  };
}

function readTotalBytes(response, offset) {
  const contentRange = response.headers.get('content-range');
  const contentRangeMatch = contentRange?.match(/\/([0-9]+)$/);
  if (contentRangeMatch) {
    return Number(contentRangeMatch[1]);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    return undefined;
  }

  return offset + contentLength;
}

function calculateProgress(receivedBytes, totalBytes) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return 0;
  }
  return Math.min(100, (receivedBytes / totalBytes) * 100);
}

function reportProgress(onProgress, event) {
  if (onProgress) {
    onProgress(event);
  }
}

async function hashFile(filePath) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(filePath), hash);
  return hash.digest('hex');
}
