import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectNvidiaGpus, exposeGpuCapacity, formatGpuCapacityTable } from '../src/lib/capacity.js';

function jwtWithExpiration(expirationSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expirationSeconds })).toString('base64url');
  return `${header}.${payload}.signature`;
}

test('detects NVIDIA GPU details and builds a dry-run listing', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmodel-capacity-'));
  const executable = path.join(directory, 'nvidia-smi');
  const previousPath = process.env.PATH;
  await writeFile(executable, '#!/bin/sh\nprintf "NVIDIA RTX 4090, 24564, 555.42\\n"\n');
  await chmod(executable, 0o755);
  process.env.PATH = `${directory}${path.delimiter}${previousPath ?? ''}`;
  try {
    const detected = await detectNvidiaGpus();
    assert.equal(detected.gpuModel, 'NVIDIA RTX 4090');
    assert.equal(detected.gpuCount, 1);
    assert.equal(detected.vramGbPerGpu, 24);

    const result = await exposeGpuCapacity({
      'price-hour': '0.75',
      endpoint: 'https://gpu.example.com/v1',
      'dry-run': true
    });
    assert.equal(result.dryRun, true);
    assert.equal(result.payload.gpuModel, 'NVIDIA RTX 4090');
    assert.equal(result.payload.connectionMode, 'OPENMODEL_API');
    assert.equal(result.payload.pricePerGpuHour, 0.75);
  } finally {
    process.env.PATH = previousPath;
    await rm(directory, { recursive: true, force: true });
  }
});

test('formats provider availability for terminal output', () => {
  const output = formatGpuCapacityTable([{
    id: 'gpu-1', status: 'PUBLISHED', gpuModel: 'NVIDIA H100 80GB',
    availableGpuCount: 2, gpuCount: 4, vramGbPerGpu: 80,
    currency: 'USD', pricePerGpuHour: 2.5, connectionMode: 'OPENMODEL_API'
  }]);
  assert.match(output, /NVIDIA H100 80GB/);
  assert.match(output, /2\/4/);
  assert.match(output, /USD 2\.50\/GPU-h/);
});

test('fails over capacity API aliases and explains HTTP 401 recovery', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmodel-capacity-auth-'));
  const previousHome = process.env.OPENMODEL_HOME;
  const previousPrimaryUrl = process.env.OPENMODEL_CLOUD_API_URL;
  const previousFallbackUrl = process.env.OPENMODEL_CLOUD_API_FALLBACK_URL;
  const previousFetch = globalThis.fetch;
  process.env.OPENMODEL_HOME = directory;
  process.env.OPENMODEL_CLOUD_API_URL = 'https://api-primary.example.com';
  process.env.OPENMODEL_CLOUD_API_FALLBACK_URL = 'https://api-fallback.example.com';
  await writeFile(path.join(directory, 'auth.json'), `${JSON.stringify({
    access_token: jwtWithExpiration(Math.floor(Date.now() / 1000) + 3600),
    obtained_at: Date.now(),
    expires_in: 3600
  })}
`);
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return new Response(JSON.stringify({ message: 'Forbidden' }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      exposeGpuCapacity({
        'gpu-model': 'NVIDIA RTX 4090',
        gpus: '1',
        'vram-gb': '24',
        'price-hour': '0.75',
        connection: 'MANUAL'
      }),
      /OpenModel authentication was rejected\. Run om logout, then om login again\./
    );
    assert.deepEqual(requests, [
      'https://api-primary.example.com/v1/capacity/gpu',
      'https://api-fallback.example.com/v1/capacity/gpu'
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    if (previousPrimaryUrl === undefined) delete process.env.OPENMODEL_CLOUD_API_URL;
    else process.env.OPENMODEL_CLOUD_API_URL = previousPrimaryUrl;
    if (previousFallbackUrl === undefined) delete process.env.OPENMODEL_CLOUD_API_FALLBACK_URL;
    else process.env.OPENMODEL_CLOUD_API_FALLBACK_URL = previousFallbackUrl;
    await rm(directory, { recursive: true, force: true });
  }
});
