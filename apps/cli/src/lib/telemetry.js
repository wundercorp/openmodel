import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPaths } from './paths.js';
import { readJson, writeJson } from './json-store.js';

const maximumStoredEvents = 100000;
const safeMetadataKeys = new Set([
  'querySource',
  'agentName',
  'skillName',
  'pluginName',
  'entrypoint',
  'transport',
  'sourceEventName',
  'accuracyReason',
  'upstreamProvider',
  'generationId'
]);

function telemetryDirectory() {
  return path.join(getPaths().home, 'telemetry');
}

function telemetryEventsPath() {
  return path.join(telemetryDirectory(), 'events.jsonl');
}

function telemetrySyncedPath() {
  return path.join(telemetryDirectory(), 'synced.json');
}

function finiteNumber(value, fallbackValue = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallbackValue;
}

function nonNegativeInteger(value) {
  return Math.max(0, Math.round(finiteNumber(value)));
}

function normalizeText(value, fallbackValue = '') {
  const normalizedValue = String(value ?? '').trim();
  return normalizedValue || fallbackValue;
}

function normalizeTimestamp(value, fallbackValue = new Date().toISOString()) {
  const parsedValue = Date.parse(String(value ?? ''));
  return Number.isFinite(parsedValue) ? new Date(parsedValue).toISOString() : fallbackValue;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const metadata = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (!safeMetadataKeys.has(key)) {
      continue;
    }
    if (typeof rawValue === 'string') {
      metadata[key] = rawValue.slice(0, 240);
    } else if (typeof rawValue === 'number' || typeof rawValue === 'boolean') {
      metadata[key] = rawValue;
    }
  }
  return metadata;
}

function inferProvider(model, source) {
  const normalizedModel = normalizeText(model).toLowerCase();
  const normalizedSource = normalizeText(source).toLowerCase();
  if (normalizedModel.includes('/')) {
    return normalizedModel.split('/', 1)[0];
  }
  if (normalizedModel.startsWith('claude') || normalizedSource.includes('claude')) {
    return 'anthropic';
  }
  if (normalizedModel.startsWith('gemini')) {
    return 'google';
  }
  if (normalizedModel.startsWith('mistral') || normalizedModel.startsWith('ministral') || normalizedModel.startsWith('codestral')) {
    return 'mistral';
  }
  if (/^(gpt-|o[1345](?:-|$)|codex)/.test(normalizedModel) || normalizedSource.includes('codex')) {
    return 'openai';
  }
  return '';
}

function normalizeProviderModel(provider, model, source) {
  const normalizedModel = normalizeText(model, 'unknown');
  const explicitProvider = normalizeText(provider).toLowerCase();
  if (explicitProvider) {
    return { provider: explicitProvider, model: normalizedModel };
  }
  if (normalizedModel.includes('/')) {
    const separatorIndex = normalizedModel.indexOf('/');
    return {
      provider: normalizedModel.slice(0, separatorIndex).toLowerCase(),
      model: normalizedModel.slice(separatorIndex + 1)
    };
  }
  return {
    provider: inferProvider(normalizedModel, source),
    model: normalizedModel
  };
}

function buildIdempotencyKey(event) {
  const stableValue = [
    event.source,
    event.sessionId,
    event.requestId,
    event.occurredAt,
    event.provider,
    event.model,
    event.usage.inputTokens,
    event.usage.outputTokens,
    event.usage.cachedInputTokens,
    event.usage.cacheWriteTokens,
    event.usage.reasoningTokens
  ].join('|');
  return `omtel_${createHash('sha256').update(stableValue).digest('hex').slice(0, 40)}`;
}

export function normalizeTelemetryEvent(input = {}, defaults = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Telemetry event must be an object.');
  }

  const source = normalizeText(input.source ?? defaults.source, 'external');
  const providerModel = normalizeProviderModel(
    input.provider ?? defaults.provider,
    input.model ?? defaults.model,
    source
  );
  const usageInput = input.usage && typeof input.usage === 'object' ? input.usage : input;
  const inputTokens = nonNegativeInteger(
    usageInput.inputTokens ?? usageInput.promptTokens ?? usageInput.prompt_tokens
  );
  const outputTokens = nonNegativeInteger(
    usageInput.outputTokens ?? usageInput.completionTokens ?? usageInput.completion_tokens
  );
  const cachedInputTokens = nonNegativeInteger(
    usageInput.cachedInputTokens
      ?? usageInput.cacheReadTokens
      ?? usageInput.cached_tokens
      ?? usageInput.cache_read_tokens
  );
  const cacheWriteTokens = nonNegativeInteger(
    usageInput.cacheWriteTokens
      ?? usageInput.cacheCreationTokens
      ?? usageInput.cache_write_tokens
      ?? usageInput.cache_creation_tokens
  );
  const reasoningTokens = nonNegativeInteger(
    usageInput.reasoningTokens
      ?? usageInput.reasoningOutputTokens
      ?? usageInput.reasoning_tokens
      ?? usageInput.reasoning_output_tokens
  );
  const calculatedTotalTokens = inputTokens + outputTokens;
  const totalTokens = Math.max(
    calculatedTotalTokens,
    nonNegativeInteger(usageInput.totalTokens ?? usageInput.total_tokens)
  );
  const occurredAt = normalizeTimestamp(
    input.occurredAt
      ?? input.completedAt
      ?? input.timestamp
      ?? defaults.occurredAt
  );
  const sessionId = normalizeText(
    input.sessionId
      ?? input.session_id
      ?? defaults.sessionId,
    `session-${createHash('sha256').update(`${source}|${occurredAt}`).digest('hex').slice(0, 16)}`
  );
  const requestId = normalizeText(
    input.requestId
      ?? input.request_id
      ?? input.generationId
      ?? defaults.requestId,
    randomUUID()
  );
  const costInput = input.cost && typeof input.cost === 'object' ? input.cost : {};
  const costAmount = Math.max(0, finiteNumber(
    costInput.amount
      ?? input.costUsd
      ?? input.cost_usd
      ?? usageInput.cost
      ?? defaults.costAmount
  ));
  const event = {
    schemaVersion: 2,
    idempotencyKey: normalizeText(input.idempotencyKey ?? input.idempotency_key),
    source,
    sourceVersion: normalizeText(input.sourceVersion ?? input.source_version ?? defaults.sourceVersion) || undefined,
    sessionId,
    requestId,
    provider: providerModel.provider,
    model: providerModel.model,
    region: normalizeText(input.region ?? defaults.region, 'global'),
    serviceTier: normalizeText(input.serviceTier ?? input.service_tier ?? defaults.serviceTier, 'default'),
    status: normalizeText(input.status ?? defaults.status, 'success').toLowerCase(),
    occurredAt,
    startedAt: input.startedAt || input.started_at
      ? normalizeTimestamp(input.startedAt ?? input.started_at, occurredAt)
      : undefined,
    durationMs: Math.max(0, finiteNumber(input.durationMs ?? input.duration_ms ?? defaults.durationMs)),
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens
    },
    cost: {
      amount: costAmount,
      currency: normalizeText(costInput.currency ?? input.currency ?? defaults.currency, 'USD').toUpperCase(),
      source: normalizeText(costInput.source ?? input.costSource ?? defaults.costSource, costAmount > 0 ? 'reported' : 'unknown')
    },
    accuracy: normalizeText(input.accuracy ?? defaults.accuracy, 'exact').toLowerCase(),
    metadata: normalizeMetadata({
      ...(defaults.metadata && typeof defaults.metadata === 'object' ? defaults.metadata : {}),
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {})
    })
  };
  event.idempotencyKey = event.idempotencyKey || buildIdempotencyKey(event);
  return event;
}

export async function readTelemetryEvents(options = {}) {
  let rawValue;
  try {
    rawValue = await readFile(telemetryEventsPath(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const sinceTimestamp = options.since ? Date.parse(String(options.since)) : Number.NEGATIVE_INFINITY;
  const untilTimestamp = options.until ? Date.parse(String(options.until)) : Number.POSITIVE_INFINITY;
  const sourceFilter = normalizeText(options.source).toLowerCase();
  const sessionFilter = normalizeText(options.sessionId);
  const limit = Math.max(1, Math.min(maximumStoredEvents, nonNegativeInteger(options.limit ?? maximumStoredEvents)));
  const events = [];

  for (const line of rawValue.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    try {
      const event = JSON.parse(line);
      const occurredAtTimestamp = Date.parse(event.occurredAt);
      if (Number.isFinite(sinceTimestamp) && occurredAtTimestamp < sinceTimestamp) {
        continue;
      }
      if (Number.isFinite(untilTimestamp) && occurredAtTimestamp >= untilTimestamp) {
        continue;
      }
      if (sourceFilter && String(event.source ?? '').toLowerCase() !== sourceFilter) {
        continue;
      }
      if (sessionFilter && event.sessionId !== sessionFilter) {
        continue;
      }
      events.push(event);
    } catch {
      continue;
    }
  }

  return events.slice(-limit);
}

export async function appendTelemetryEvents(inputs, defaults = {}) {
  const inputEvents = Array.isArray(inputs) ? inputs : [inputs];
  const normalizedEvents = inputEvents.map((event) => normalizeTelemetryEvent(event, defaults));
  const existingEvents = await readTelemetryEvents();
  const existingKeys = new Set(existingEvents.map((event) => event.idempotencyKey));
  const acceptedEvents = [];
  let duplicates = 0;

  for (const event of normalizedEvents) {
    if (existingKeys.has(event.idempotencyKey)) {
      duplicates += 1;
      continue;
    }
    existingKeys.add(event.idempotencyKey);
    acceptedEvents.push(event);
  }

  if (acceptedEvents.length > 0) {
    await mkdir(telemetryDirectory(), { recursive: true, mode: 0o700 });
    await appendFile(
      telemetryEventsPath(),
      acceptedEvents.map((event) => `${JSON.stringify(event)}\n`).join(''),
      { mode: 0o600 }
    );
  }

  return {
    accepted: acceptedEvents.length,
    duplicates,
    events: acceptedEvents
  };
}

export function summarizeTelemetryEvents(events, options = {}) {
  const sourceMap = new Map();
  const modelMap = new Map();
  const sessionMap = new Map();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let reportedCost = 0;
  let successfulRequests = 0;
  let failedRequests = 0;

  for (const event of events) {
    inputTokens += nonNegativeInteger(event.usage?.inputTokens);
    outputTokens += nonNegativeInteger(event.usage?.outputTokens);
    cachedInputTokens += nonNegativeInteger(event.usage?.cachedInputTokens);
    cacheWriteTokens += nonNegativeInteger(event.usage?.cacheWriteTokens);
    reasoningTokens += nonNegativeInteger(event.usage?.reasoningTokens);
    totalTokens += nonNegativeInteger(event.usage?.totalTokens);
    reportedCost += Math.max(0, finiteNumber(event.cost?.amount));
    if (event.status === 'success') {
      successfulRequests += 1;
    } else {
      failedRequests += 1;
    }

    const source = normalizeText(event.source, 'external');
    const modelKey = `${normalizeText(event.provider, 'unknown')}/${normalizeText(event.model, 'unknown')}`;
    const sessionKey = `${source}:${normalizeText(event.sessionId, 'unknown')}`;
    const sourceSummary = sourceMap.get(source) ?? { source, requests: 0, totalTokens: 0, reportedCost: 0 };
    sourceSummary.requests += 1;
    sourceSummary.totalTokens += nonNegativeInteger(event.usage?.totalTokens);
    sourceSummary.reportedCost += Math.max(0, finiteNumber(event.cost?.amount));
    sourceMap.set(source, sourceSummary);
    const modelSummary = modelMap.get(modelKey) ?? {
      provider: normalizeText(event.provider, 'unknown'),
      model: normalizeText(event.model, 'unknown'),
      requests: 0,
      totalTokens: 0,
      reportedCost: 0
    };
    modelSummary.requests += 1;
    modelSummary.totalTokens += nonNegativeInteger(event.usage?.totalTokens);
    modelSummary.reportedCost += Math.max(0, finiteNumber(event.cost?.amount));
    modelMap.set(modelKey, modelSummary);
    const sessionSummary = sessionMap.get(sessionKey) ?? {
      sessionId: event.sessionId,
      source,
      provider: event.provider,
      model: event.model,
      requests: 0,
      totalTokens: 0,
      reportedCost: 0,
      startedAt: event.startedAt ?? event.occurredAt,
      lastEventAt: event.occurredAt
    };
    sessionSummary.requests += 1;
    sessionSummary.totalTokens += nonNegativeInteger(event.usage?.totalTokens);
    sessionSummary.reportedCost += Math.max(0, finiteNumber(event.cost?.amount));
    if (Date.parse(event.occurredAt) > Date.parse(sessionSummary.lastEventAt)) {
      sessionSummary.lastEventAt = event.occurredAt;
      sessionSummary.provider = event.provider;
      sessionSummary.model = event.model;
    }
    if (Date.parse(event.startedAt ?? event.occurredAt) < Date.parse(sessionSummary.startedAt)) {
      sessionSummary.startedAt = event.startedAt ?? event.occurredAt;
    }
    sessionMap.set(sessionKey, sessionSummary);
  }

  return {
    generatedAt: new Date().toISOString(),
    scope: 'local-external',
    privacy: {
      promptContentStored: false,
      responseContentStored: false,
      metadataAllowlisted: true,
      persistence: 'jsonl'
    },
    range: {
      since: options.since,
      until: options.until
    },
    requests: {
      total: events.length,
      successful: successfulRequests,
      failed: failedRequests
    },
    usage: {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalTokens
    },
    cost: {
      reported: Math.round(reportedCost * 100000000) / 100000000,
      currency: 'USD'
    },
    sessions: [...sessionMap.values()]
      .sort((left, right) => Date.parse(right.lastEventAt) - Date.parse(left.lastEventAt)),
    bySource: [...sourceMap.values()]
      .sort((left, right) => right.totalTokens - left.totalTokens),
    byModel: [...modelMap.values()]
      .sort((left, right) => right.totalTokens - left.totalTokens),
    recentEvents: [...events]
      .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
      .slice(0, 100)
  };
}

export async function readTelemetrySummary(options = {}) {
  const events = await readTelemetryEvents(options);
  return summarizeTelemetryEvents(events, options);
}

export async function readSyncedTelemetryKeys() {
  const payload = await readJson(telemetrySyncedPath(), { keys: [] });
  return new Set(Array.isArray(payload.keys) ? payload.keys : []);
}

export async function markTelemetryEventsSynced(events) {
  const syncedKeys = await readSyncedTelemetryKeys();
  for (const event of events) {
    syncedKeys.add(event.idempotencyKey);
  }
  await writeJson(telemetrySyncedPath(), {
    updatedAt: new Date().toISOString(),
    keys: [...syncedKeys].slice(-maximumStoredEvents)
  });
}

export async function readUnsyncedTelemetryEvents(options = {}) {
  const [events, syncedKeys] = await Promise.all([
    readTelemetryEvents(options),
    readSyncedTelemetryKeys()
  ]);
  return events.filter((event) => !syncedKeys.has(event.idempotencyKey));
}

export function toWundershipUsageEvent(event) {
  if (!event.provider || !event.model || event.model === 'unknown') {
    return undefined;
  }
  return {
    schemaVersion: 1,
    idempotencyKey: event.idempotencyKey,
    source: `openmodel-${event.source}`,
    provider: event.provider,
    model: event.model,
    region: event.region || 'global',
    serviceTier: event.serviceTier || 'default',
    usage: {
      inputTokens: nonNegativeInteger(event.usage?.inputTokens),
      outputTokens: nonNegativeInteger(event.usage?.outputTokens),
      cachedInputTokens: nonNegativeInteger(event.usage?.cachedInputTokens),
      cacheWriteTokens: nonNegativeInteger(event.usage?.cacheWriteTokens),
      reasoningTokens: nonNegativeInteger(event.usage?.reasoningTokens)
    },
    occurredAt: event.occurredAt
  };
}
