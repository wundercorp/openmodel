import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { enrollProviderNode, providerNodeHeartbeat, runProviderAgent } from '../src/lib/provider.js';

test('builds a provider node enrollment without contacting the master in dry-run mode', async () => {
  const result = await enrollProviderNode({
    'dry-run': true,
    name: 'worker-1',
    'gpu-model': 'NVIDIA RTX 4090',
    gpus: 1,
    'vram-gb': 24,
    endpoint: 'https://worker.example.com'
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.body.gpuModel, 'NVIDIA RTX 4090');
  assert.equal(result.body.healthStatus, 'REGISTERING');
});

test('runs one provider agent cycle with a node-scoped token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmodel-provider-'));
  const previousHome = process.env.OPENMODEL_HOME;
  const previousFetch = globalThis.fetch;
  process.env.OPENMODEL_HOME = directory;
  await writeFile(path.join(directory, 'config.json'), `${JSON.stringify({
    aliases: {},
    gateways: [],
    provider: {
      lastNodeId: 'node-1',
      nodes: {
        'node-1': {
          id: 'node-1',
          name: 'worker-1',
          token: 'node-1.secret',
          apiBaseUrl: 'https://api.example.test'
        }
      }
    }
  })}\n`, { mode: 0o600 });
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/heartbeat')) {
      return new Response(JSON.stringify({ data: {
        id: 'node-1', healthStatus: 'READY', availableGpuCount: 1, reservedGpuCount: 0
      } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ data: [{
      id: 'reservation-1', status: 'ASSIGNED', gpuCount: 1, requestedHours: 1
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const output = [];
  try {
    const result = await runProviderAgent({
      once: true,
      'node-id': 'node-1',
      'api-url': 'https://api.example.test',
      gpus: 1,
      'available-gpus': 1,
      'gpu-model': 'NVIDIA RTX 4090',
      'vram-gb': 24
    }, { output: (value) => output.push(value) });
    assert.equal(result.assignmentCount, 1);
    assert.equal(output.length, 1);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].init.headers.authorization, 'Node node-1.secret');
    assert.equal(requests[1].init.headers.authorization, 'Node node-1.secret');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});


test('preserves the provider configured GPU subset during automatic heartbeats', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmodel-provider-subset-'));
  const previousHome = process.env.OPENMODEL_HOME;
  const previousFetch = globalThis.fetch;
  process.env.OPENMODEL_HOME = directory;
  await writeFile(path.join(directory, 'config.json'), `${JSON.stringify({
    aliases: {},
    gateways: [],
    provider: {
      lastNodeId: 'node-subset',
      nodes: {
        'node-subset': {
          id: 'node-subset',
          name: 'worker-subset',
          token: 'node-subset.secret',
          apiBaseUrl: 'https://api.example.test',
          gpuCount: 1,
          reportedAvailableGpuCount: 0,
          vramGbPerGpu: 24
        }
      }
    }
  })}
`, { mode: 0o600 });
  let heartbeatBody;
  globalThis.fetch = async (_url, init = {}) => {
    heartbeatBody = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ data: {
      id: 'node-subset', gpuCount: 1, reportedAvailableGpuCount: 0,
      availableGpuCount: 0, reservedGpuCount: 0, healthStatus: 'READY'
    } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await providerNodeHeartbeat({ 'node-id': 'node-subset' });
    assert.equal(heartbeatBody.gpuCount, 1);
    assert.equal(heartbeatBody.availableGpuCount, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(directory, { recursive: true, force: true });
  }
});
