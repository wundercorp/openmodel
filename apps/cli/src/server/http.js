import http from 'node:http';
import { findManifest, listManifests } from '../lib/model-store.js';
import { selectRuntime } from '../runtimes/index.js';

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) return '';
  return messages.map((message) => `${message.role ?? 'user'}: ${message.content ?? ''}`).join('\n');
}

export async function startLocalServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = Number(options.port ?? 11435);
  const defaultModel = options.model;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === 'OPTIONS') return sendJson(response, 204, {});
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === 'GET' && url.pathname === '/health') return sendJson(response, 200, { status: 'ok' });
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const manifests = await listManifests();
        return sendJson(response, 200, { object: 'list', data: manifests.map((manifest) => ({ id: manifest.storedId, object: 'model', owned_by: manifest.gatewayId })) });
      }
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        const manifests = await listManifests();
        return sendJson(response, 200, { models: manifests.map((manifest) => ({ name: manifest.storedId, model: manifest.storedId, modified_at: manifest.createdAt, size: 0 })) });
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJsonBody(request);
        const manifest = await findManifest(body.model ?? defaultModel);
        if (!manifest) return sendJson(response, 404, { error: { message: 'Model is not installed.' } });
        const runtime = await selectRuntime(manifest, options.runtime ?? 'auto');
        const content = await runtime.generate(manifest, messagesToPrompt(body.messages), { maxTokens: body.max_tokens });
        return sendJson(response, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: manifest.storedId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        });
      }
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        const body = await readJsonBody(request);
        const manifest = await findManifest(body.model ?? defaultModel);
        if (!manifest) return sendJson(response, 404, { error: 'Model is not installed.' });
        const runtime = await selectRuntime(manifest, options.runtime ?? 'auto');
        const output = await runtime.generate(manifest, String(body.prompt ?? ''));
        return sendJson(response, 200, { model: manifest.storedId, created_at: new Date().toISOString(), response: output, done: true });
      }
      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(`OpenModel local API listening on http://${host}:${port}\n`);
  return server;
}
