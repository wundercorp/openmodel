import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('reports local runtime availability separately from model installation', async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'openmodel-test-'));
  const previousHome = process.env.OPENMODEL_HOME;
  process.env.OPENMODEL_HOME = temporaryHome;
  const server = await startLocalServer({ port: 0 });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/runtime-status`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.platform, process.platform);
    assert.equal(payload.data.architecture, process.arch);
    assert.ok(Array.isArray(payload.data.runtimes));
    assert.ok(payload.data.runtimes.some((runtime) => runtime.id === 'llama.cpp'));
    assert.ok(Array.isArray(payload.data.models));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});


test('exposes local-only inference metrics and supports trusted resets', async () => {
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
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${baseUrl}/v1/metrics`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.data.scope, 'local');
    assert.equal(payload.data.privacy.localOnly, true);
    assert.equal(payload.data.inference.totalRequests, 0);
    assert.ok(Array.isArray(payload.data.recentRequests));

    const resetResponse = await fetch(`${baseUrl}/v1/metrics/reset`, {
      method: 'POST',
      headers: { origin: 'https://openmodel.sh' }
    });
    assert.equal(resetResponse.status, 200);
    const resetPayload = await resetResponse.json();
    assert.equal(resetPayload.data.reset, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});


test('records chat completion token and latency metrics', async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'openmodel-test-'));
  const previousHome = process.env.OPENMODEL_HOME;
  const previousPath = process.env.PATH;
  const binaryDirectory = path.join(temporaryHome, 'bin');
  const manifestDirectory = path.join(temporaryHome, 'manifests');
  const modelDirectory = path.join(temporaryHome, 'models', 'test-model');
  const modelPath = path.join(modelDirectory, 'test-model.gguf');
  const llamaCompletionPath = path.join(binaryDirectory, 'llama-completion');
  const llamaCliPath = path.join(binaryDirectory, 'llama-cli');
  process.env.OPENMODEL_HOME = temporaryHome;

  await mkdir(binaryDirectory, { recursive: true });
  await mkdir(manifestDirectory, { recursive: true });
  await mkdir(modelDirectory, { recursive: true });
  const fakeRuntimeScript = '#!/bin/sh\nprintf "OpenModel metrics are working"\n';
  await writeFile(llamaCompletionPath, fakeRuntimeScript);
  await writeFile(llamaCliPath, fakeRuntimeScript);
  await chmod(llamaCompletionPath, 0o755);
  await chmod(llamaCliPath, 0o755);
  await writeFile(modelPath, 'test-model');
  await writeFile(
    path.join(manifestDirectory, 'test-model.json'),
    JSON.stringify({
      schemaVersion: 1,
      storedId: 'test-model',
      gatewayId: 'huggingface',
      model: {
        id: 'test-model',
        displayName: 'Test Model',
        format: 'gguf',
        runtimeHints: ['llama.cpp'],
        artifacts: []
      },
      artifactPaths: [modelPath],
      createdAt: new Date().toISOString()
    })
  );
  process.env.PATH = `${binaryDirectory}${path.delimiter}${previousPath ?? ''}`;

  const server = await startLocalServer({ port: 0 });
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const completionResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello metrics' }],
        max_tokens: 32
      })
    });
    assert.equal(completionResponse.status, 200);
    const completionPayload = await completionResponse.json();
    assert.equal(completionPayload.choices[0].message.content, 'OpenModel metrics are working');
    assert.equal(completionPayload.usage.estimated, true);
    assert.ok(completionPayload.usage.total_tokens > 0);

    const metricsResponse = await fetch(`${baseUrl}/v1/metrics`);
    assert.equal(metricsResponse.status, 200);
    const metricsPayload = await metricsResponse.json();
    assert.equal(metricsPayload.data.inference.totalRequests, 1);
    assert.equal(metricsPayload.data.inference.successfulRequests, 1);
    assert.ok(metricsPayload.data.inference.totalTokens > 0);
    assert.equal(metricsPayload.data.models.byModel[0].modelId, 'test-model');
    assert.equal(metricsPayload.data.models.byModel[0].runtimeId, 'llama.cpp');
    assert.equal(metricsPayload.data.recentRequests[0].status, 'success');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});
