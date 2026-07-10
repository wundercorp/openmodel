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
