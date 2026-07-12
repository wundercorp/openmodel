import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { telemetrySetupGuide, telemetrySetupText } from '../src/index.js';
import {
  appendTelemetryEvents,
  normalizeTelemetryEvent,
  readTelemetryEvents,
  readTelemetrySummary,
  toWundershipUsageEvent
} from '../src/lib/telemetry.js';
import {
  decodeOtlpJsonLogs,
  decodeOtlpProtobufLogs,
  telemetryEventsFromOtlpRecords
} from '../src/lib/otlp-logs.js';

function encodeVarint(value) {
  let remainingValue = BigInt(value);
  const bytes = [];
  while (remainingValue >= 0x80n) {
    bytes.push(Number((remainingValue & 0x7fn) | 0x80n));
    remainingValue >>= 7n;
  }
  bytes.push(Number(remainingValue));
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber, wireType) {
  return encodeVarint(BigInt((fieldNumber << 3) | wireType));
}

function encodeBytesField(fieldNumber, value) {
  const bufferValue = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([encodeTag(fieldNumber, 2), encodeVarint(bufferValue.length), bufferValue]);
}

function encodeStringField(fieldNumber, value) {
  return encodeBytesField(fieldNumber, Buffer.from(value));
}

function encodeFixed64Field(fieldNumber, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([encodeTag(fieldNumber, 1), buffer]);
}

function encodeDoubleField(fieldNumber, value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleLE(value);
  return Buffer.concat([encodeTag(fieldNumber, 1), buffer]);
}

function encodeAnyValue(value) {
  if (typeof value === 'string') return encodeStringField(1, value);
  if (typeof value === 'boolean') return Buffer.concat([encodeTag(2, 0), encodeVarint(value ? 1 : 0)]);
  if (Number.isInteger(value)) return Buffer.concat([encodeTag(3, 0), encodeVarint(value)]);
  if (typeof value === 'number') return encodeDoubleField(4, value);
  throw new Error('Unsupported test AnyValue.');
}

function encodeKeyValue(key, value) {
  return Buffer.concat([
    encodeStringField(1, key),
    encodeBytesField(2, encodeAnyValue(value))
  ]);
}

function encodeClaudeLogRequest() {
  const resource = encodeBytesField(1, encodeKeyValue('service.name', 'claude-code'));
  const attributes = [
    ['event.name', 'claude_code.api_request'],
    ['session.id', 'session-1'],
    ['request_id', 'request-1'],
    ['model', 'claude-sonnet-4-6'],
    ['input_tokens', 100],
    ['output_tokens', 20],
    ['cache_read_tokens', 10],
    ['cache_creation_tokens', 5],
    ['cost_usd', 0.002],
    ['duration_ms', 250]
  ].map(([key, value]) => encodeBytesField(6, encodeKeyValue(key, value)));
  const timestamp = BigInt(Date.parse('2026-07-11T12:00:00Z')) * 1000000n;
  const logRecord = Buffer.concat([
    encodeFixed64Field(1, timestamp),
    ...attributes
  ]);
  const scopeLogs = encodeBytesField(2, logRecord);
  const resourceLogs = Buffer.concat([
    encodeBytesField(1, resource),
    encodeBytesField(2, scopeLogs)
  ]);
  return encodeBytesField(1, resourceLogs);
}

test('normalizes telemetry without retaining prompt or response content', () => {
  const event = normalizeTelemetryEvent({
    source: 'openrouter',
    sessionId: 'session-1',
    requestId: 'request-1',
    model: 'openai/gpt-4o-mini',
    prompt: 'private prompt',
    response: 'private response',
    usage: {
      prompt_tokens: 100,
      completion_tokens: 20
    },
    metadata: {
      querySource: 'main',
      privateField: 'do not store'
    }
  });

  assert.equal(event.provider, 'openai');
  assert.equal(event.model, 'gpt-4o-mini');
  assert.equal(event.usage.totalTokens, 120);
  assert.equal(event.prompt, undefined);
  assert.equal(event.response, undefined);
  assert.equal(event.metadata.querySource, 'main');
  assert.equal(event.metadata.privateField, undefined);
});

test('normalizes provider-prefixed models even when provider is explicit', () => {
  const event = normalizeTelemetryEvent({
    source: 'wundercorp-bs',
    provider: 'openai',
    model: 'openai/gpt-5.5-20260423',
    usage: { inputTokens: 10, outputTokens: 2 }
  });

  assert.equal(event.provider, 'openai');
  assert.equal(event.model, 'gpt-5.5-20260423');
});

test('persists, deduplicates, summarizes, and converts telemetry events', async () => {
  const temporaryHome = await mkdtemp(path.join(os.tmpdir(), 'openmodel-telemetry-test-'));
  const previousHome = process.env.OPENMODEL_HOME;
  process.env.OPENMODEL_HOME = temporaryHome;
  try {
    const input = {
      source: 'claude-code',
      sessionId: 'session-1',
      requestId: 'request-1',
      model: 'claude-sonnet-4-6',
      occurredAt: '2026-07-11T12:00:00Z',
      usage: { inputTokens: 100, outputTokens: 20 },
      cost: { amount: 0.002, currency: 'USD' }
    };
    const firstResult = await appendTelemetryEvents(input);
    const secondResult = await appendTelemetryEvents(input);
    assert.equal(firstResult.accepted, 1);
    assert.equal(secondResult.duplicates, 1);
    const events = await readTelemetryEvents();
    const summary = await readTelemetrySummary();
    assert.equal(events.length, 1);
    assert.equal(summary.usage.totalTokens, 120);
    assert.equal(summary.sessions.length, 1);
    const usageEvent = toWundershipUsageEvent(events[0]);
    assert.equal(usageEvent.provider, 'anthropic');
    assert.equal(usageEvent.model, 'claude-sonnet-4-6');
  } finally {
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    await rm(temporaryHome, { recursive: true, force: true });
  }
});

test('converts Claude Code OTLP JSON logs into exact usage events', () => {
  const records = decodeOtlpJsonLogs({
    resourceLogs: [{
      resource: {
        attributes: [{ key: 'service.name', value: { stringValue: 'claude-code' } }]
      },
      scopeLogs: [{
        logRecords: [{
          timeUnixNano: '1783771200000000000',
          attributes: [
            { key: 'event.name', value: { stringValue: 'claude_code.api_request' } },
            { key: 'session.id', value: { stringValue: 'session-1' } },
            { key: 'request_id', value: { stringValue: 'request-1' } },
            { key: 'model', value: { stringValue: 'claude-sonnet-4-6' } },
            { key: 'input_tokens', value: { intValue: '100' } },
            { key: 'output_tokens', value: { intValue: '20' } },
            { key: 'cost_usd', value: { doubleValue: 0.002 } }
          ]
        }]
      }]
    }]
  });
  const events = telemetryEventsFromOtlpRecords(records);
  assert.equal(events.length, 1);
  assert.equal(events[0].source, 'claude-code');
  assert.equal(events[0].usage.totalTokens, 120);
  assert.equal(events[0].cost.amount, 0.002);
});

test('decodes OTLP protobuf logs and extracts Claude Code token usage', () => {
  const records = decodeOtlpProtobufLogs(encodeClaudeLogRequest());
  const events = telemetryEventsFromOtlpRecords(records);
  assert.equal(records.length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].sessionId, 'session-1');
  assert.equal(events[0].usage.inputTokens, 100);
  assert.equal(events[0].usage.outputTokens, 20);
  assert.equal(events[0].usage.cachedInputTokens, 10);
  assert.equal(events[0].cost.amount, 0.002);
});


test('prints a guided external usage setup flow', () => {
  const guide = telemetrySetupGuide(11435);
  assert.match(guide, /om serve --port 11435/);
  assert.match(guide, /om setup claude-code --launch/);
  assert.match(guide, /om telemetry summary/);
  assert.match(guide, /om telemetry sync/);
});

test('generates clear Claude Code and Codex setup output', () => {
  const claudeSetup = telemetrySetupText('claude-code', 11435);
  assert.match(claudeSetup, /CLAUDE_CODE_ENABLE_TELEMETRY=1/);
  assert.match(claudeSetup, /OTEL_LOG_USER_PROMPTS=0/);
  assert.match(claudeSetup, /127\.0\.0\.1:11435/);

  const codexSetup = telemetrySetupText('codex', 11435);
  assert.match(codexSetup, /~\/.codex\/config\.toml/);
  assert.match(codexSetup, /\[otel\]/);
  assert.match(codexSetup, /protocol = "binary"/);
});
