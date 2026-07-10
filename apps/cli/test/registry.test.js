import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReference } from '../src/gateways/registry.js';

test('resolves a Hugging Face GGUF reference', async () => {
  const result = await resolveReference('hf://owner/repository/model.gguf');
  assert.equal(result.gateway.id, 'huggingface');
  assert.equal(result.model.format, 'gguf');
});

test('resolves an Ollama native reference', async () => {
  const result = await resolveReference('ollama://qwen2.5:3b');
  assert.equal(result.model.native.runtime, 'ollama');
});
