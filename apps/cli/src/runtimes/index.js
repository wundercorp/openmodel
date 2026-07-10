import { llamaCppRuntime } from './llamacpp.js';
import { ollamaRuntime } from './ollama.js';

const runtimes = [llamaCppRuntime, ollamaRuntime];

export async function selectRuntime(manifest, requestedRuntime = 'auto') {
  if (requestedRuntime !== 'auto') {
    const runtime = runtimes.find((candidate) => candidate.id === requestedRuntime);
    if (!runtime) throw new Error(`Unknown runtime "${requestedRuntime}".`);
    if (!(await runtime.available())) throw new Error(`Runtime "${requestedRuntime}" is not available.`);
    return runtime;
  }
  for (const hint of manifest.model.runtimeHints ?? []) {
    const runtime = runtimes.find((candidate) => candidate.id === hint);
    if (runtime && await runtime.available()) return runtime;
  }
  throw new Error('No compatible runtime is available. Install llama.cpp for GGUF models or Ollama for Ollama references.');
}

export { runtimes };
