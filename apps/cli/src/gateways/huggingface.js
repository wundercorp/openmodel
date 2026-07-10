import path from 'node:path';
import { defineGateway } from '@wundercorp/openmodel-gateway-sdk';

export default defineGateway({
  id: 'huggingface',
  name: 'Hugging Face',
  apiVersion: 1,
  schemes: ['hf'],
  capabilities: ['resolve', 'download', 'auth'],
  canHandle(reference) {
    return reference.toLowerCase().startsWith('hf://');
  },
  async resolve(context) {
    const parsed = new URL(context.reference);
    const segments = `${parsed.hostname}${parsed.pathname}`.split('/').filter(Boolean);
    if (segments.length < 3) throw new Error('Hugging Face references must use hf://owner/repository/path/to/file.gguf');
    const owner = segments.shift();
    const repository = segments.shift();
    const filePath = segments.join('/');
    const revision = parsed.searchParams.get('revision') ?? 'main';
    const token = await context.credentials.get('huggingface');
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    return {
      id: `${owner}/${repository}/${filePath}`,
      source: context.reference,
      displayName: path.basename(filePath),
      format: extensionFormat(filePath),
      artifacts: [{
        url: `https://huggingface.co/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/resolve/${encodeURIComponent(revision)}/${filePath.split('/').map(encodeURIComponent).join('/')}`,
        fileName: path.basename(filePath),
        headers
      }],
      runtimeHints: filePath.toLowerCase().endsWith('.gguf') ? ['llama.cpp', 'ollama'] : []
    };
  }
});

function extensionFormat(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase();
  return extension || 'unknown';
}
