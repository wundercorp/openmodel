import { commandExists, runProcess } from '../lib/process.js';

const candidates = ['llama-cli', 'main'];

async function findBinary() {
  for (const candidate of candidates) if (await commandExists(candidate)) return candidate;
  return undefined;
}

export const llamaCppRuntime = {
  id: 'llama.cpp',
  async available() { return Boolean(await findBinary()); },
  async run(manifest, prompt, options = {}) {
    const binary = await findBinary();
    if (!binary) throw new Error('llama.cpp was not found. Install llama-cli and ensure it is on PATH.');
    const modelPath = manifest.artifactPaths?.[0];
    if (!modelPath) throw new Error('The model manifest has no local artifact.');
    const argumentsList = ['-m', modelPath, '-p', prompt, '-n', String(options.maxTokens ?? 512)];
    await runProcess(binary, argumentsList);
  },
  async generate(manifest, prompt, options = {}) {
    const binary = await findBinary();
    if (!binary) throw new Error('llama.cpp was not found. Install llama-cli and ensure it is on PATH.');
    const modelPath = manifest.artifactPaths?.[0];
    const result = await runProcess(binary, ['-m', modelPath, '-p', prompt, '-n', String(options.maxTokens ?? 512), '--no-display-prompt'], { capture: true });
    return result.stdout.trim();
  }
};
