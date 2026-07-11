import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startLocalServer } from '../src/server/http.js';

test('exposes the curated local model catalog', async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'openmodel-test-'));
  const previousHome = process.env.OPENMODEL_HOME;
  process.env.OPENMODEL_HOME = temporaryHome;
  const server = await startLocalServer({ port: 0 });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/model-catalog`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data[0].id, 'qwen2.5-0.5b-instruct-q4');
    assert.equal(payload.data[0].installed, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test('rejects model installation requests from untrusted browser origins', async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'openmodel-test-'));
  const previousHome = process.env.OPENMODEL_HOME;
  process.env.OPENMODEL_HOME = temporaryHome;
  const server = await startLocalServer({
    port: 0,
    allowedOrigins: ['https://openmodel.sh']
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/models/install`, {
      method: 'POST',
      headers: {
        origin: 'https://example.com',
        'content-type': 'application/json'
      },
      body: JSON.stringify({ catalogId: 'qwen2.5-0.5b-instruct-q4' })
    });
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
