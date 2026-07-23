import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGenerateArguments,
  extractGeneratedText
} from '../src/runtimes/llamacpp.js';

test('llama.cpp generation runs as a captured single turn', () => {
  const argumentsList = buildGenerateArguments('/tmp/model.gguf', 'Hello', {
    maxTokens: 64
  });

  assert.deepEqual(argumentsList.slice(0, 6), [
    '-m',
    '/tmp/model.gguf',
    '-p',
    'Hello',
    '-n',
    '64'
  ]);
  assert.ok(argumentsList.includes('--single-turn'));
  assert.ok(argumentsList.includes('--simple-io'));
  assert.ok(argumentsList.includes('--no-display-prompt'));
  assert.ok(!argumentsList.includes('--log-disable'));
  assert.deepEqual(argumentsList.slice(-2), ['--color', 'off']);
});

test('extracts only the assistant text from recent llama-cli output', () => {
  const output = `Loading model...

▄▄ ▄▄
██ ██

build      : b9950-961e4b26a
model      : /tmp/model.gguf
ftype      : Q4_K - Medium
modalities : text

available commands:
  /exit or Ctrl+C     stop or exit
  /regen              regenerate the last response

> user: Hello
Hello! How can I assist you today?

Exiting...`;

  assert.equal(
    extractGeneratedText(output, 'user: Hello'),
    'Hello! How can I assist you today?'
  );
});

test('preserves already clean llama-completion output', () => {
  assert.equal(
    extractGeneratedText('OpenModel is ready\n', 'user: Hello'),
    'OpenModel is ready'
  );
});

test('removes trailing prompt and timing lines', () => {
  const output = `> user: Reply with exactly: OpenModel is ready
OpenModel is ready

[ Prompt: 137.2 t/s | Generation: 336.3 t/s ]

>`;

  assert.equal(
    extractGeneratedText(output, 'user: Reply with exactly: OpenModel is ready'),
    'OpenModel is ready'
  );
});
