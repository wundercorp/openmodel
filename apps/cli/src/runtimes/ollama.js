import { commandExists, runProcess } from '../lib/process.js';

export const ollamaRuntime = {
  id: 'ollama',
  async available() { return commandExists('ollama'); },
  async pull(model) { await runProcess('ollama', ['pull', model]); },
  async run(manifest, prompt) {
    const model = manifest.model.native?.model ?? manifest.model.id;
    await runProcess('ollama', ['run', model, prompt]);
  },
  async generate(manifest, prompt) {
    const model = manifest.model.native?.model ?? manifest.model.id;
    const result = await runProcess('ollama', ['run', model, prompt], { capture: true });
    return result.stdout.trim();
  }
};
