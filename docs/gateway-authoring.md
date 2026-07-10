# Gateway authoring

A gateway adapts a model catalog, registry, URL scheme, or remote service to OpenModel's normalized model descriptor.

## Package manifest

```json
{
  "name": "@acme/openmodel-gateway-example",
  "type": "module",
  "exports": "./src/index.js",
  "openmodel": {
    "kind": "gateway",
    "apiVersion": 1
  }
}
```

## Contract

```js
import { defineGateway } from '@wundercorp/openmodel-gateway-sdk';

export default defineGateway({
  id: 'example',
  name: 'Example Registry',
  apiVersion: 1,
  schemes: ['example'],
  capabilities: ['resolve', 'download'],
  canHandle(reference) {
    return reference.startsWith('example://');
  },
  async resolve(context) {
    return {
      id: 'publisher/model',
      source: context.reference,
      displayName: 'Publisher Model',
      format: 'gguf',
      artifacts: [
        {
          url: 'https://models.example/model.gguf',
          fileName: 'model.gguf'
        }
      ],
      runtimeHints: ['llama.cpp']
    };
  }
});
```

## Compatibility rules

Gateways should return portable metadata and avoid embedding provider-specific behavior in core commands. Use `native` only when a provider requires its own installed runtime. Use artifact URLs for portable model files. Include integrity hashes when the upstream registry publishes them.

Credentials belong in the gateway context credential resolver. Never include credentials in returned URLs, logs, manifests, aliases, or thrown error messages.

A gateway must reject malformed references early and produce actionable errors. Network requests must receive the provided abort signal.
