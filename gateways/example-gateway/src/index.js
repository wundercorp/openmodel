import path from 'node:path';
import { defineGateway } from '@wundercorp/openmodel-gateway-sdk';

export default defineGateway({
  id: 'example',
  name: 'Example Model Registry',
  apiVersion: 1,
  schemes: ['example'],
  capabilities: ['resolve', 'download'],
  canHandle(reference) {
    return reference.toLowerCase().startsWith('example://');
  },
  async resolve(context) {
    const parsed = new URL(context.reference);
    const modelPath = `${parsed.hostname}${parsed.pathname}`.replace(/^\/+/, '');
    if (!modelPath) throw new Error('Example references must include a model path.');
    const fileName = path.basename(modelPath);
    return {
      id: modelPath,
      source: context.reference,
      displayName: fileName,
      format: path.extname(fileName).slice(1).toLowerCase() || 'unknown',
      artifacts: [{
        url: `https://models.example.invalid/${modelPath.split('/').map(encodeURIComponent).join('/')}`,
        fileName
      }],
      runtimeHints: fileName.endsWith('.gguf') ? ['llama.cpp'] : []
    };
  }
});
