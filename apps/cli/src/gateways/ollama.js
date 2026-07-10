import { defineGateway } from '@wundercorp/openmodel-gateway-sdk';

export default defineGateway({
  id: 'ollama',
  name: 'Ollama Registry',
  apiVersion: 1,
  schemes: ['ollama'],
  capabilities: ['resolve', 'native-pull'],
  canHandle(reference) {
    return reference.toLowerCase().startsWith('ollama://');
  },
  async resolve(context) {
    const model = context.reference.slice('ollama://'.length).trim();
    if (!model) throw new Error('Ollama references must include a model name.');
    return {
      id: model,
      source: context.reference,
      displayName: model,
      format: 'ollama',
      artifacts: [],
      native: { runtime: 'ollama', model },
      runtimeHints: ['ollama']
    };
  }
});
