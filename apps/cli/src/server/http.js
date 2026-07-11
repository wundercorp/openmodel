import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { findManifest, listManifests } from '../lib/model-store.js';
import { installModel } from '../lib/install-model.js';
import { selectRuntime } from '../runtimes/index.js';

const defaultAllowedBrowserOrigins = [
  'https://openmodel.sh',
  'https://www.openmodel.sh',
  'http://localhost:5173',
  'http://127.0.0.1:5173'
];

const starterModelCatalog = [
  {
    id: 'qwen2.5-0.5b-instruct-q4',
    name: 'Qwen2.5 0.5B Instruct',
    description: 'A compact instruction model intended as a quick first local download.',
    reference: 'hf://Qwen/Qwen2.5-0.5B-Instruct-GGUF/qwen2.5-0.5b-instruct-q4_k_m.gguf',
    alias: 'qwen-small',
    format: 'GGUF · Q4_K_M',
    parameterCount: '0.5B',
    sizeBytes: 491000000,
    license: 'Apache-2.0',
    sourceUrl: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF'
  }
];

const installJobs = new Map();
const activeInstallJobsByCatalogId = new Map();

function createCorsHeaders(request, options) {
  const requestOrigin = request.headers.origin;
  const allowedOrigins = readAllowedOrigins(options);
  const allowedOrigin = requestOrigin && allowedOrigins.includes(requestOrigin)
    ? requestOrigin
    : requestOrigin
      ? 'null'
      : '*';

  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
}

function readAllowedOrigins(options) {
  const configuredOrigins = options.allowedOrigins ?? process.env.OPENMODEL_ALLOWED_BROWSER_ORIGINS;
  if (Array.isArray(configuredOrigins)) {
    return configuredOrigins.map((value) => String(value).trim()).filter(Boolean);
  }
  if (typeof configuredOrigins === 'string' && configuredOrigins.trim()) {
    return configuredOrigins.split(',').map((value) => value.trim()).filter(Boolean);
  }
  return defaultAllowedBrowserOrigins;
}

function isTrustedBrowserRequest(request, options) {
  const requestOrigin = request.headers.origin;
  if (!requestOrigin) {
    return true;
  }
  return readAllowedOrigins(options).includes(requestOrigin);
}

function sendJson(response, statusCode, value, corsHeaders) {
  response.writeHead(statusCode, {
    ...corsHeaders,
    'content-type': 'application/json; charset=utf-8'
  });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) {
    return {};
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) {
    return '';
  }
  return messages.map((message) => `${message.role ?? 'user'}: ${message.content ?? ''}`).join('\n');
}

function serializeInstallJob(job) {
  return {
    id: job.id,
    catalogId: job.catalogId,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    message: job.message,
    fileName: job.fileName,
    downloadedBytes: job.downloadedBytes,
    totalBytes: job.totalBytes,
    modelId: job.modelId,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt
  };
}

async function readCatalogWithInstallationState() {
  const manifests = await listManifests();
  return starterModelCatalog.map((catalogModel) => {
    const installedManifest = manifests.find(
      (manifest) => manifest.model?.source === catalogModel.reference
    );
    return {
      ...catalogModel,
      installed: Boolean(installedManifest),
      installedModelId: installedManifest?.storedId
    };
  });
}

function updateInstallJob(job, progressEvent) {
  const now = new Date().toISOString();
  job.updatedAt = now;
  if (Number.isFinite(progressEvent.progress)) {
    job.progress = Math.max(job.progress, Math.min(100, Math.round(progressEvent.progress)));
  }
  if (progressEvent.type) {
    job.stage = progressEvent.type;
  }
  if (progressEvent.message) {
    job.message = progressEvent.message;
  }
  if (progressEvent.fileName) {
    job.fileName = progressEvent.fileName;
  }
  if (Number.isFinite(progressEvent.receivedBytes)) {
    job.downloadedBytes = progressEvent.receivedBytes;
  }
  if (Number.isFinite(progressEvent.totalBytes)) {
    job.totalBytes = progressEvent.totalBytes;
  }
}

function startInstallJob(catalogModel) {
  const existingJobId = activeInstallJobsByCatalogId.get(catalogModel.id);
  if (existingJobId) {
    const existingJob = installJobs.get(existingJobId);
    if (existingJob && ['queued', 'resolving', 'downloading', 'installing'].includes(existingJob.status)) {
      return existingJob;
    }
  }

  const createdAt = new Date().toISOString();
  const job = {
    id: randomUUID(),
    catalogId: catalogModel.id,
    status: 'queued',
    progress: 0,
    stage: 'queued',
    message: 'Preparing the local model download.',
    fileName: undefined,
    downloadedBytes: 0,
    totalBytes: catalogModel.sizeBytes,
    modelId: undefined,
    error: undefined,
    createdAt,
    updatedAt: createdAt,
    completedAt: undefined
  };

  installJobs.set(job.id, job);
  activeInstallJobsByCatalogId.set(catalogModel.id, job.id);

  void installModel(catalogModel.reference, {
    alias: catalogModel.alias,
    onProgress(progressEvent) {
      if (progressEvent.type === 'download-start' || progressEvent.type === 'download-progress') {
        job.status = 'downloading';
      } else if (progressEvent.type === 'complete') {
        job.status = 'installing';
      } else {
        job.status = progressEvent.type === 'resolving' ? 'resolving' : 'installing';
      }
      updateInstallJob(job, progressEvent);
    }
  })
    .then((manifest) => {
      job.status = 'completed';
      job.stage = 'complete';
      job.progress = 100;
      job.modelId = manifest.storedId;
      job.message = `${catalogModel.name} is installed locally.`;
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
    })
    .catch((error) => {
      job.status = 'error';
      job.stage = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      job.message = 'The model installation failed.';
      job.updatedAt = new Date().toISOString();
    })
    .finally(() => {
      activeInstallJobsByCatalogId.delete(catalogModel.id);
      pruneInstallJobs();
    });

  return job;
}

function pruneInstallJobs() {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const [jobId, job] of installJobs.entries()) {
    if (Date.parse(job.updatedAt) < cutoff) {
      installJobs.delete(jobId);
    }
  }
}

export async function startLocalServer(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const port = Number(options.port ?? 11435);
  const defaultModel = options.model;
  const server = http.createServer(async (request, response) => {
    const corsHeaders = createCorsHeaders(request, options);
    try {
      if (request.method === 'OPTIONS') {
        if (!isTrustedBrowserRequest(request, options)) {
          return sendJson(response, 403, { error: 'This browser origin is not allowed to control the local OpenModel service.' }, corsHeaders);
        }
        return sendJson(response, 204, {}, corsHeaders);
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === 'GET' && url.pathname === '/health') {
        return sendJson(response, 200, { status: 'ok' }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/models') {
        const manifests = await listManifests();
        return sendJson(response, 200, {
          object: 'list',
          data: manifests.map((manifest) => ({
            id: manifest.storedId,
            object: 'model',
            owned_by: manifest.gatewayId
          }))
        }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/model-catalog') {
        return sendJson(response, 200, { data: await readCatalogWithInstallationState() }, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/v1/models/install') {
        if (!isTrustedBrowserRequest(request, options)) {
          return sendJson(response, 403, { error: 'This browser origin is not allowed to install models.' }, corsHeaders);
        }
        const body = await readJsonBody(request);
        const catalogModel = starterModelCatalog.find((candidate) => candidate.id === body.catalogId);
        if (!catalogModel) {
          return sendJson(response, 400, { error: 'Choose a model from the local OpenModel catalog.' }, corsHeaders);
        }

        const manifests = await listManifests();
        const installedManifest = manifests.find(
          (manifest) => manifest.model?.source === catalogModel.reference
        );
        if (installedManifest) {
          const now = new Date().toISOString();
          return sendJson(response, 200, {
            data: {
              id: `installed-${catalogModel.id}`,
              catalogId: catalogModel.id,
              status: 'completed',
              progress: 100,
              stage: 'complete',
              message: `${catalogModel.name} is already installed.`,
              downloadedBytes: catalogModel.sizeBytes,
              totalBytes: catalogModel.sizeBytes,
              modelId: installedManifest.storedId,
              createdAt: installedManifest.createdAt ?? now,
              updatedAt: now,
              completedAt: now
            }
          }, corsHeaders);
        }

        const job = startInstallJob(catalogModel);
        return sendJson(response, 202, { data: serializeInstallJob(job) }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/model-installs/')) {
        const jobId = decodeURIComponent(url.pathname.slice('/v1/model-installs/'.length));
        const job = installJobs.get(jobId);
        if (!job) {
          return sendJson(response, 404, { error: 'Model installation job was not found.' }, corsHeaders);
        }
        return sendJson(response, 200, { data: serializeInstallJob(job) }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/api/tags') {
        const manifests = await listManifests();
        return sendJson(response, 200, {
          models: manifests.map((manifest) => ({
            name: manifest.storedId,
            model: manifest.storedId,
            modified_at: manifest.createdAt,
            size: 0
          }))
        }, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
        const body = await readJsonBody(request);
        const manifest = await findManifest(body.model ?? defaultModel);
        if (!manifest) {
          return sendJson(response, 404, { error: { message: 'Model is not installed.' } }, corsHeaders);
        }
        const runtime = await selectRuntime(manifest, options.runtime ?? 'auto');
        const content = await runtime.generate(manifest, messagesToPrompt(body.messages), { maxTokens: body.max_tokens });
        return sendJson(response, 200, {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: manifest.storedId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }]
        }, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        const body = await readJsonBody(request);
        const manifest = await findManifest(body.model ?? defaultModel);
        if (!manifest) {
          return sendJson(response, 404, { error: 'Model is not installed.' }, corsHeaders);
        }
        const runtime = await selectRuntime(manifest, options.runtime ?? 'auto');
        const output = await runtime.generate(manifest, String(body.prompt ?? ''));
        return sendJson(response, 200, {
          model: manifest.storedId,
          created_at: new Date().toISOString(),
          response: output,
          done: true
        }, corsHeaders);
      }
      return sendJson(response, 404, { error: 'Not found' }, corsHeaders);
    } catch (error) {
      return sendJson(response, 500, {
        error: error instanceof Error ? error.message : String(error)
      }, corsHeaders);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const listeningPort = address && typeof address === 'object' ? address.port : port;
  process.stdout.write(`OpenModel local API listening on http://${host}:${listeningPort}\n`);
  return server;
}
