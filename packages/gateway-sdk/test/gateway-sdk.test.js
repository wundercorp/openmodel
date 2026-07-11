import test from 'node:test';
import assert from 'node:assert/strict';
import { defineGateway, parseReferenceScheme, validateResolvedModel } from '../src/index.js';

test('defineGateway accepts a valid gateway', () => {
  const gateway = defineGateway({
    id: 'example',
    name: 'Example',
    apiVersion: 1,
    schemes: ['example'],
    capabilities: ['resolve', 'download'],
    canHandle(reference) {
      return reference.startsWith('example://');
    },
    async resolve() {
      return {};
    }
  });

  assert.equal(gateway.id, 'example');
});

test('parseReferenceScheme normalizes schemes', () => {
  assert.equal(parseReferenceScheme('HF://owner/repository/model.gguf'), 'hf');
});

test('validateResolvedModel validates portable artifacts', () => {
  const model = validateResolvedModel({
    id: 'owner/model',
    source: 'example://owner/model',
    displayName: 'Model',
    format: 'gguf',
    artifacts: [{ url: 'https://example.com/model.gguf', fileName: 'model.gguf' }],
    runtimeHints: ['llama.cpp']
  });

  assert.equal(model.artifacts.length, 1);
});

test('normalizes OpenRouter response usage into an OpenModel telemetry event', async () => {
  const { usageEventFromOpenRouterResponse } = await import('../src/index.js');
  const event = usageEventFromOpenRouterResponse({
    id: 'gen-1',
    model: 'openai/gpt-4o-mini',
    usage: {
      prompt_tokens: 194,
      completion_tokens: 2,
      total_tokens: 196,
      cost: 0.00014,
      prompt_tokens_details: {
        cached_tokens: 10,
        cache_write_tokens: 5
      },
      completion_tokens_details: {
        reasoning_tokens: 1
      }
    }
  }, { sessionId: 'session-1' });

  assert.equal(event.provider, 'openai');
  assert.equal(event.model, 'gpt-4o-mini');
  assert.equal(event.usage.inputTokens, 194);
  assert.equal(event.usage.cachedInputTokens, 10);
  assert.equal(event.usage.reasoningTokens, 1);
  assert.equal(event.cost.amount, 0.00014);
});

test('reports normalized usage to the local OpenModel telemetry endpoint', async () => {
  const { createUsageReporter } = await import('../src/index.js');
  let request;
  const reportUsage = createUsageReporter({
    source: 'wundercorp-bs',
    fetch: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ data: { accepted: 1 } }), {
        status: 202,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const result = await reportUsage({ model: 'gpt-4o-mini', usage: { inputTokens: 1, outputTokens: 2 } });
  assert.equal(result.accepted, 1);
  assert.equal(request.url, 'http://127.0.0.1:11435/v1/telemetry/events');
  assert.equal(JSON.parse(request.options.body).event.source, 'wundercorp-bs');
});
