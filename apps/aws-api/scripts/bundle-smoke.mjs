import assert from 'node:assert/strict';

process.env.ALLOWED_ORIGINS = 'https://openmodel.sh';
delete process.env.GATEWAY_REGISTRY_TABLE;

const bundleUrl = new URL(`../dist/index.mjs?smoke=${Date.now()}`, import.meta.url);
const { handler } = await import(bundleUrl.href);

const healthResponse = await handler({
  rawPath: '/health',
  headers: { origin: 'https://openmodel.sh' },
  requestContext: { http: { method: 'GET' } }
});

assert.equal(healthResponse.statusCode, 200);
assert.deepEqual(JSON.parse(healthResponse.body), {
  status: 'ok',
  service: 'openmodel-aws-api'
});

const gatewayResponse = await handler({
  rawPath: '/v1/gateways',
  headers: { origin: 'https://openmodel.sh' },
  requestContext: { http: { method: 'GET' } }
});

assert.equal(gatewayResponse.statusCode, 200);
assert.deepEqual(
  JSON.parse(gatewayResponse.body).data.map((gateway) => gateway.id),
  ['huggingface', 'direct', 'ollama']
);

console.log('Bundled Lambda smoke test passed.');
