import assert from 'node:assert/strict';
import test from 'node:test';
import { handler } from '../src/index.mjs';

test('returns the public health response', async () => {
  process.env.ALLOWED_ORIGINS = 'https://openmodel.sh';
  const response = await handler({
    rawPath: '/health',
    headers: { origin: 'https://openmodel.sh' },
    requestContext: { http: { method: 'GET' } }
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { status: 'ok', service: 'openmodel-aws-api' });
  assert.equal(response.headers['access-control-allow-origin'], 'https://openmodel.sh');
});

test('returns built-in gateways without a registry table', async () => {
  delete process.env.GATEWAY_REGISTRY_TABLE;
  process.env.ALLOWED_ORIGINS = 'https://openmodel.sh';
  const response = await handler({
    rawPath: '/v1/gateways',
    headers: {},
    requestContext: { http: { method: 'GET' } }
  });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.data.length, 3);
  assert.deepEqual(body.data.map((gateway) => gateway.id), ['huggingface', 'direct', 'ollama']);
});
