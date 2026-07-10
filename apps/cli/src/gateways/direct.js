import path from 'node:path';
import { defineGateway } from '@wundercorp/openmodel-gateway-sdk';

export default defineGateway({
  id: 'direct',
  name: 'Direct HTTPS',
  apiVersion: 1,
  schemes: ['http', 'https'],
  capabilities: ['resolve', 'download'],
  canHandle(reference) {
    try { return ['http:', 'https:'].includes(new URL(reference).protocol); } catch { return false; }
  },
  async resolve(context) {
    const url = new URL(context.reference);
    const fileName = path.basename(url.pathname) || 'model.bin';
    return {
      id: `${url.hostname}/${fileName}`,
      source: context.reference,
      displayName: fileName,
      format: path.extname(fileName).slice(1).toLowerCase() || 'unknown',
      artifacts: [{ url: url.toString(), fileName }],
      runtimeHints: fileName.toLowerCase().endsWith('.gguf') ? ['llama.cpp', 'ollama'] : []
    };
  }
});
