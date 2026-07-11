import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { findManifest, listManifests } from '../lib/model-store.js';
import { installModel } from '../lib/install-model.js';
import { createLocalMetricsStore } from '../lib/metrics.js';
import { getRuntimeStatus, RuntimeUnavailableError, selectRuntime } from '../runtimes/index.js';
import { appendTelemetryEvents, readTelemetryEvents, readTelemetrySummary } from '../lib/telemetry.js';
import { decodeOtlpLogs, telemetryEventsFromOtlpRecords } from '../lib/otlp-logs.js';

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

function isLoopbackAddress(value) {
  const normalizedValue = String(value ?? '').toLowerCase();
  return normalizedValue === '127.0.0.1'
    || normalizedValue === '::1'
    || normalizedValue === '::ffff:127.0.0.1';
}

function isLocalProcessRequest(request) {
  return !request.headers.origin && isLoopbackAddress(request.socket.remoteAddress);
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

async function readRequestBody(request, maximumBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new Error('Request body is too large.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const body = await readRequestBody(request);
  if (body.length === 0) {
    return {};
  }
  return JSON.parse(body.toString('utf8'));
}

function sendOtlpResponse(response, statusCode, contentType, corsHeaders) {
  const normalizedContentType = String(contentType ?? '').toLowerCase();
  if (normalizedContentType.includes('json')) {
    response.writeHead(statusCode, {
      ...corsHeaders,
      'content-type': 'application/json; charset=utf-8'
    });
    response.end('{}\n');
    return;
  }
  response.writeHead(statusCode, {
    ...corsHeaders,
    'content-type': 'application/x-protobuf'
  });
  response.end();
}

function messagesToPrompt(messages) {
  if (!Array.isArray(messages)) {
    return '';
  }
  return messages.map((message) => `${message.role ?? 'user'}: ${message.content ?? ''}`).join('\n');
}


async function calculateModelStorageBytes(manifests) {
  let totalBytes = 0;
  for (const manifest of manifests) {
    for (const artifactPath of manifest.artifactPaths ?? []) {
      try {
        const artifactStats = await stat(artifactPath);
        if (artifactStats.isFile()) {
          totalBytes += artifactStats.size;
        }
      } catch {
        continue;
      }
    }
  }
  return totalBytes;
}

function createRequestAbortController(request, response) {
  const abortController = new AbortController();
  const abortRequest = () => abortController.abort();
  const abortClosedResponse = () => {
    if (!response.writableEnded) {
      abortController.abort();
    }
  };

  request.once('aborted', abortRequest);
  response.once('close', abortClosedResponse);

  return {
    signal: abortController.signal,
    cleanup() {
      request.removeListener('aborted', abortRequest);
      response.removeListener('close', abortClosedResponse);
    }
  };
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
  const metricsStore = createLocalMetricsStore();
  let runtimeStatusCache;
  let runtimeStatusCacheAt = 0;
  let runtimeStatusManifestSignature = '';

  async function readRuntimeStatus(manifests, maximumAgeMs = 5000) {
    const manifestSignature = manifests.map((manifest) => manifest.storedId).join('|');
    const cacheIsCurrent =
      runtimeStatusCache &&
      runtimeStatusManifestSignature === manifestSignature &&
      Date.now() - runtimeStatusCacheAt < maximumAgeMs;
    if (cacheIsCurrent) {
      return runtimeStatusCache;
    }

    runtimeStatusCache = await getRuntimeStatus(manifests);
    runtimeStatusCacheAt = Date.now();
    runtimeStatusManifestSignature = manifestSignature;
    return runtimeStatusCache;
  }
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
        return sendJson(response, 200, {
          status: 'ok',
          service: 'openmodel-local-api',
          platform: process.platform,
          architecture: process.arch,
          capabilities: [
            'models',
            'model-catalog',
            'model-install',
            'install-progress',
            'runtime-status',
            'chat-completions',
            'metrics',
            'external-usage-telemetry',
            'otlp-logs'
          ]
        }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/runtime-status') {
        const manifests = await listManifests();
        return sendJson(response, 200, { data: await readRuntimeStatus(manifests, 0) }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/metrics') {
        const manifests = await listManifests();
        const [runtimeStatus, modelStorageBytes, externalUsage] = await Promise.all([
          readRuntimeStatus(manifests),
          calculateModelStorageBytes(manifests),
          readTelemetrySummary({
            since: url.searchParams.get('since') ?? undefined,
            limit: 10000
          })
        ]);
        return sendJson(response, 200, {
          data: {
            ...metricsStore.snapshot({
              manifests,
              runtimeStatus,
              modelStorageBytes,
              installJobs: [...installJobs.values()],
              host,
              port: server.address() && typeof server.address() === 'object'
                ? server.address().port
                : port
            }),
            externalUsage
          }
        }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/telemetry/events') {
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const events = await readTelemetryEvents({
          limit,
          since: url.searchParams.get('since') ?? undefined,
          until: url.searchParams.get('until') ?? undefined,
          source: url.searchParams.get('source') ?? undefined,
          sessionId: url.searchParams.get('sessionId') ?? undefined
        });
        return sendJson(response, 200, { data: events }, corsHeaders);
      }
      if (request.method === 'GET' && url.pathname === '/v1/telemetry/summary') {
        const summary = await readTelemetrySummary({
          limit: Number(url.searchParams.get('limit') ?? 10000),
          since: url.searchParams.get('since') ?? undefined,
          until: url.searchParams.get('until') ?? undefined,
          source: url.searchParams.get('source') ?? undefined,
          sessionId: url.searchParams.get('sessionId') ?? undefined
        });
        return sendJson(response, 200, { data: summary }, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/v1/telemetry/events') {
        if (!isLocalProcessRequest(request) && !isTrustedBrowserRequest(request, options)) {
          return sendJson(response, 403, { error: 'This request is not allowed to submit local telemetry.' }, corsHeaders);
        }
        const body = await readJsonBody(request);
        const result = await appendTelemetryEvents(body.events ?? body.event ?? body);
        return sendJson(response, 202, { data: result }, corsHeaders);
      }
      if (
        request.method === 'POST'
        && (url.pathname === '/v1/telemetry/otlp/v1/logs' || url.pathname === '/v1/logs')
      ) {
        if (!isLocalProcessRequest(request)) {
          return sendJson(response, 403, { error: 'OTLP telemetry is accepted only from a local process.' }, corsHeaders);
        }
        const contentType = request.headers['content-type'] ?? 'application/x-protobuf';
        const body = await readRequestBody(request, 8 * 1024 * 1024);
        const records = decodeOtlpLogs(body, contentType);
        const events = telemetryEventsFromOtlpRecords(records);
        await appendTelemetryEvents(events);
        return sendOtlpResponse(response, 200, contentType, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/v1/metrics/reset') {
        if (!isTrustedBrowserRequest(request, options)) {
          return sendJson(response, 403, { error: 'This browser origin is not allowed to reset local metrics.' }, corsHeaders);
        }
        if (metricsStore.getActiveRequestCount() > 0) {
          return sendJson(response, 409, { error: 'Wait for active inference requests to finish before resetting metrics.' }, corsHeaders);
        }
        metricsStore.reset();
        return sendJson(response, 200, { data: { reset: true, resetAt: new Date().toISOString() } }, corsHeaders);
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
        const prompt = messagesToPrompt(body.messages);
        const inferenceMetrics = metricsStore.beginInference({
          endpoint: '/v1/chat/completions',
          modelId: manifest.storedId,
          prompt
        });
        let inferenceRequest;
        try {
          const runtime = await selectRuntime(manifest, options.runtime ?? 'auto');
          metricsStore.setRuntime(inferenceMetrics, runtime.id);
          inferenceRequest = createRequestAbortController(request, response);
          const content = await runtime.generate(
            manifest,
            prompt,
            {
              maxTokens: body.max_tokens,
              signal: inferenceRequest.signal
            }
          );
          const usage = metricsStore.completeInference(inferenceMetrics, content);
          return sendJson(response, 200, {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: manifest.storedId,
            choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: usage.promptTokens,
              completion_tokens: usage.completionTokens,
              total_tokens: usage.totalTokens,
              estimated: usage.estimated
            },
            openmodel_metrics: {
              latency_ms: usage.latencyMs,
              completion_tokens_per_second: usage.tokensPerSecond
            }
          }, corsHeaders);
        } catch (error) {
          metricsStore.failInference(inferenceMetrics, error);
          throw error;
        } finally {
          inferenceRequest?.cleanup();
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        const body = await readJsonBody(request);
        const manifest = await findManifest(body.model ?? defaultModel);
        if (!manifest) {
          return sendJson(response, 404, { error: 'Model is not installed.' }, corsHeaders);
        }
        const prompt = String(body.prompt ?? '');
        const inferenceMetrics = metricsStore.beginInference({
          endpoint: '/api/generate',
          modelId: manifest.storedId,
          prompt
        });
        let inferenceRequest;
        try {
          const runtime = await selectRuntime(manifest, options.runtime ?? 'auto');
          metricsStore.setRuntime(inferenceMetrics, runtime.id);
          inferenceRequest = createRequestAbortController(request, response);
          const output = await runtime.generate(
            manifest,
            prompt,
            { signal: inferenceRequest.signal }
          );
          const usage = metricsStore.completeInference(inferenceMetrics, output);
          return sendJson(response, 200, {
            model: manifest.storedId,
            created_at: new Date().toISOString(),
            response: output,
            done: true,
            prompt_eval_count: usage.promptTokens,
            eval_count: usage.completionTokens,
            total_duration: usage.latencyMs * 1000000,
            openmodel_usage_estimated: usage.estimated
          }, corsHeaders);
        } catch (error) {
          metricsStore.failInference(inferenceMetrics, error);
          throw error;
        } finally {
          inferenceRequest?.cleanup();
        }
      }
      return sendJson(response, 404, { error: 'Not found' }, corsHeaders);
    } catch (error) {
      if (response.destroyed || response.writableEnded) {
        return;
      }
      if (error instanceof RuntimeUnavailableError) {
        return sendJson(response, error.statusCode, {
          error: {
            code: error.code,
            message: error.message,
            details: error.details
          }
        }, corsHeaders);
      }
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
