import { normalizeTelemetryEvent } from './telemetry.js';

function readVarint(buffer, offset) {
  let value = 0n;
  let shift = 0n;
  let cursor = offset;
  while (cursor < buffer.length) {
    const byte = BigInt(buffer[cursor]);
    cursor += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) {
      return { value, offset: cursor };
    }
    shift += 7n;
    if (shift > 70n) {
      throw new Error('Invalid protobuf varint.');
    }
  }
  throw new Error('Unexpected end of protobuf varint.');
}

function readFields(buffer) {
  const fields = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tagResult = readVarint(buffer, offset);
    offset = tagResult.offset;
    const fieldNumber = Number(tagResult.value >> 3n);
    const wireType = Number(tagResult.value & 7n);
    if (wireType === 0) {
      const valueResult = readVarint(buffer, offset);
      fields.push({ fieldNumber, wireType, value: valueResult.value });
      offset = valueResult.offset;
      continue;
    }
    if (wireType === 1) {
      if (offset + 8 > buffer.length) {
        throw new Error('Unexpected end of protobuf fixed64.');
      }
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 8) });
      offset += 8;
      continue;
    }
    if (wireType === 2) {
      const lengthResult = readVarint(buffer, offset);
      const length = Number(lengthResult.value);
      offset = lengthResult.offset;
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > buffer.length) {
        throw new Error('Invalid protobuf length-delimited field.');
      }
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + length) });
      offset += length;
      continue;
    }
    if (wireType === 5) {
      if (offset + 4 > buffer.length) {
        throw new Error('Unexpected end of protobuf fixed32.');
      }
      fields.push({ fieldNumber, wireType, value: buffer.subarray(offset, offset + 4) });
      offset += 4;
      continue;
    }
    throw new Error(`Unsupported protobuf wire type ${wireType}.`);
  }
  return fields;
}

function firstField(fields, fieldNumber) {
  return fields.find((field) => field.fieldNumber === fieldNumber);
}

function repeatedFields(fields, fieldNumber) {
  return fields.filter((field) => field.fieldNumber === fieldNumber);
}

function decodeString(value) {
  return Buffer.from(value).toString('utf8');
}

function decodeFixed64BigInt(value) {
  return Buffer.from(value).readBigUInt64LE(0);
}

function decodeDouble(value) {
  return Buffer.from(value).readDoubleLE(0);
}

function decodeAnyValue(buffer) {
  const fields = readFields(buffer);
  const stringField = firstField(fields, 1);
  if (stringField) {
    return decodeString(stringField.value);
  }
  const boolField = firstField(fields, 2);
  if (boolField) {
    return boolField.value !== 0n;
  }
  const integerField = firstField(fields, 3);
  if (integerField) {
    return Number(integerField.value);
  }
  const doubleField = firstField(fields, 4);
  if (doubleField) {
    return decodeDouble(doubleField.value);
  }
  const arrayField = firstField(fields, 5);
  if (arrayField) {
    const arrayFields = readFields(arrayField.value);
    return repeatedFields(arrayFields, 1).map((field) => decodeAnyValue(field.value));
  }
  const keyValueListField = firstField(fields, 6);
  if (keyValueListField) {
    return decodeKeyValueList(keyValueListField.value);
  }
  const bytesField = firstField(fields, 7);
  if (bytesField) {
    return Buffer.from(bytesField.value).toString('base64');
  }
  return undefined;
}

function decodeKeyValue(buffer) {
  const fields = readFields(buffer);
  const keyField = firstField(fields, 1);
  const valueField = firstField(fields, 2);
  if (!keyField || !valueField) {
    return undefined;
  }
  return [decodeString(keyField.value), decodeAnyValue(valueField.value)];
}

function decodeKeyValueList(buffer) {
  const fields = readFields(buffer);
  const value = {};
  for (const field of repeatedFields(fields, 1)) {
    const entry = decodeKeyValue(field.value);
    if (entry) {
      value[entry[0]] = entry[1];
    }
  }
  return value;
}

function decodeAttributes(fields, fieldNumber) {
  const attributes = {};
  for (const field of repeatedFields(fields, fieldNumber)) {
    const entry = decodeKeyValue(field.value);
    if (entry) {
      attributes[entry[0]] = entry[1];
    }
  }
  return attributes;
}

function decodeResource(buffer) {
  return decodeAttributes(readFields(buffer), 1);
}

function nanosecondsToIsoString(nanoseconds) {
  if (!nanoseconds || nanoseconds === 0n) {
    return undefined;
  }
  const milliseconds = Number(nanoseconds / 1000000n);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : undefined;
}

function decodeLogRecord(buffer, resourceAttributes = {}) {
  const fields = readFields(buffer);
  const timeField = firstField(fields, 1) ?? firstField(fields, 11);
  const bodyField = firstField(fields, 5);
  const eventNameField = firstField(fields, 12);
  return {
    resourceAttributes,
    attributes: decodeAttributes(fields, 6),
    body: bodyField ? decodeAnyValue(bodyField.value) : undefined,
    eventName: eventNameField ? decodeString(eventNameField.value) : undefined,
    occurredAt: timeField ? nanosecondsToIsoString(decodeFixed64BigInt(timeField.value)) : undefined
  };
}

function decodeScopeLogs(buffer, resourceAttributes) {
  const fields = readFields(buffer);
  return repeatedFields(fields, 2).map((field) => decodeLogRecord(field.value, resourceAttributes));
}

function decodeResourceLogs(buffer) {
  const fields = readFields(buffer);
  const resourceField = firstField(fields, 1);
  const resourceAttributes = resourceField ? decodeResource(resourceField.value) : {};
  return repeatedFields(fields, 2).flatMap((field) => decodeScopeLogs(field.value, resourceAttributes));
}

export function decodeOtlpProtobufLogs(buffer) {
  const fields = readFields(buffer);
  return repeatedFields(fields, 1).flatMap((field) => decodeResourceLogs(field.value));
}

function anyValueFromJson(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }
  if ('stringValue' in value) return value.stringValue;
  if ('boolValue' in value) return Boolean(value.boolValue);
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('bytesValue' in value) return value.bytesValue;
  if (value.arrayValue?.values) return value.arrayValue.values.map(anyValueFromJson);
  if (value.kvlistValue?.values) return keyValuesFromJson(value.kvlistValue.values);
  return value;
}

function keyValuesFromJson(values) {
  const result = {};
  for (const entry of Array.isArray(values) ? values : []) {
    if (entry?.key) {
      result[entry.key] = anyValueFromJson(entry.value);
    }
  }
  return result;
}

export function decodeOtlpJsonLogs(payload) {
  const resourceLogs = payload?.resourceLogs ?? payload?.resource_logs ?? [];
  return resourceLogs.flatMap((resourceLog) => {
    const resourceAttributes = keyValuesFromJson(resourceLog?.resource?.attributes);
    const scopeLogs = resourceLog?.scopeLogs ?? resourceLog?.scope_logs ?? [];
    return scopeLogs.flatMap((scopeLog) => {
      const logRecords = scopeLog?.logRecords ?? scopeLog?.log_records ?? [];
      return logRecords.map((record) => ({
        resourceAttributes,
        attributes: keyValuesFromJson(record.attributes),
        body: anyValueFromJson(record.body),
        eventName: record.eventName ?? record.event_name,
        occurredAt: record.timeUnixNano || record.time_unix_nano
          ? nanosecondsToIsoString(BigInt(record.timeUnixNano ?? record.time_unix_nano))
          : undefined
      }));
    });
  });
}

function flattenBody(body) {
  if (!body) {
    return {};
  }
  if (typeof body === 'object' && !Array.isArray(body)) {
    return body;
  }
  if (typeof body === 'string') {
    try {
      const parsedValue = JSON.parse(body);
      return parsedValue && typeof parsedValue === 'object' ? parsedValue : { message: body };
    } catch {
      return { message: body };
    }
  }
  return { value: body };
}

function readAttribute(attributes, names, fallbackValue = undefined) {
  for (const name of names) {
    if (attributes[name] !== undefined && attributes[name] !== null) {
      return attributes[name];
    }
  }
  return fallbackValue;
}

function normalizeEventName(record, attributes, body) {
  return String(
    record.eventName
      ?? readAttribute(attributes, ['event.name', 'name'])
      ?? body['event.name']
      ?? body.name
      ?? body.message
      ?? ''
  ).trim();
}

function sourceFromRecord(eventName, resourceAttributes) {
  const serviceName = String(resourceAttributes['service.name'] ?? '').toLowerCase();
  const normalizedEventName = eventName.toLowerCase();
  if (normalizedEventName.startsWith('claude_code.') || serviceName.includes('claude')) {
    return 'claude-code';
  }
  if (normalizedEventName.startsWith('codex.') || serviceName.includes('codex')) {
    return 'codex';
  }
  return serviceName || 'otel-genai';
}

function shouldCaptureEvent(eventName, source, attributes) {
  const normalizedEventName = eventName.toLowerCase();
  if (source === 'claude-code') {
    return normalizedEventName === 'claude_code.api_request'
      || normalizedEventName === 'api_request';
  }
  if (source === 'codex') {
    const kind = String(readAttribute(attributes, ['kind', 'event.kind', 'type'], '')).toLowerCase();
    return normalizedEventName === 'codex.sse_event' && kind === 'response.completed'
      || normalizedEventName === 'codex.websocket_event' && kind === 'response.completed'
      || normalizedEventName === 'codex.turn.token_usage'
      || normalizedEventName === 'turn.token_usage';
  }
  return normalizedEventName.includes('api_request')
    || normalizedEventName.includes('response.completed')
    || normalizedEventName.includes('token_usage');
}

export function telemetryEventsFromOtlpRecords(records) {
  const events = [];
  for (const record of records) {
    const body = flattenBody(record.body);
    const attributes = {
      ...(record.resourceAttributes ?? {}),
      ...(body ?? {}),
      ...(record.attributes ?? {})
    };
    const eventName = normalizeEventName(record, attributes, body);
    const source = sourceFromRecord(eventName, record.resourceAttributes ?? {});
    if (!shouldCaptureEvent(eventName, source, attributes)) {
      continue;
    }
    const model = readAttribute(attributes, [
      'model',
      'gen_ai.request.model',
      'gen_ai.response.model',
      'request.model',
      'response.model'
    ], 'unknown');
    const provider = readAttribute(attributes, [
      'provider',
      'gen_ai.provider.name',
      'gen_ai.system',
      'upstream_provider'
    ], undefined);
    const sessionId = readAttribute(attributes, [
      'session.id',
      'session_id',
      'conversation.id',
      'conversation_id',
      'thread.id',
      'thread_id'
    ], undefined);
    const requestId = readAttribute(attributes, [
      'request_id',
      'request.id',
      'gen_ai.response.id',
      'response.id',
      'generation_id'
    ], undefined);
    const inputTokens = readAttribute(attributes, [
      'input_tokens',
      'input_token_count',
      'prompt_tokens',
      'usage.input_tokens',
      'gen_ai.usage.input_tokens'
    ], 0);
    const outputTokens = readAttribute(attributes, [
      'output_tokens',
      'output_token_count',
      'completion_tokens',
      'usage.output_tokens',
      'gen_ai.usage.output_tokens'
    ], 0);
    const cachedInputTokens = readAttribute(attributes, [
      'cache_read_tokens',
      'cached_input_tokens',
      'cached_tokens',
      'usage.cached_input_tokens'
    ], 0);
    const cacheWriteTokens = readAttribute(attributes, [
      'cache_creation_tokens',
      'cache_write_tokens',
      'usage.cache_write_tokens'
    ], 0);
    const reasoningTokens = readAttribute(attributes, [
      'reasoning_tokens',
      'reasoning_output_tokens',
      'usage.reasoning_tokens'
    ], 0);
    const costUsd = readAttribute(attributes, [
      'cost_usd',
      'usage.cost',
      'cost',
      'gen_ai.usage.cost'
    ], 0);
    const successValue = readAttribute(attributes, ['success'], true);
    const status = successValue === false || String(successValue).toLowerCase() === 'false'
      ? 'error'
      : 'success';
    const event = normalizeTelemetryEvent({
      source,
      sourceVersion: record.resourceAttributes?.['service.version'],
      sessionId,
      requestId,
      provider,
      model,
      status,
      occurredAt: record.occurredAt ?? readAttribute(attributes, ['event.timestamp', 'timestamp']),
      durationMs: readAttribute(attributes, ['duration_ms', 'duration.ms'], 0),
      usage: {
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens: readAttribute(attributes, ['total_tokens', 'usage.total_tokens'], 0)
      },
      cost: {
        amount: costUsd,
        currency: 'USD',
        source: Number(costUsd) > 0 ? 'tool-reported' : 'unknown'
      },
      accuracy: 'exact',
      metadata: {
        querySource: readAttribute(attributes, ['query_source']),
        agentName: readAttribute(attributes, ['agent.name']),
        skillName: readAttribute(attributes, ['skill.name']),
        pluginName: readAttribute(attributes, ['plugin.name']),
        entrypoint: readAttribute(attributes, ['app.entrypoint']),
        transport: source === 'codex'
          ? eventName.includes('websocket') ? 'websocket' : 'sse'
          : 'api',
        sourceEventName: eventName
      }
    });
    if (event.usage.totalTokens > 0 || event.cost.amount > 0) {
      events.push(event);
    }
  }
  return events;
}

export function decodeOtlpLogs(body, contentType = '') {
  const normalizedContentType = String(contentType).toLowerCase();
  if (normalizedContentType.includes('json')) {
    return decodeOtlpJsonLogs(JSON.parse(Buffer.from(body).toString('utf8')));
  }
  return decodeOtlpProtobufLogs(Buffer.from(body));
}
