import { createGatewayContext, parseReferenceScheme, validateGateway, validateResolvedModel } from '@wundercorp/openmodel-gateway-sdk';
import huggingfaceGateway from './huggingface.js';
import directGateway from './direct.js';
import ollamaGateway from './ollama.js';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readConfig } from '../lib/config.js';
import { getPaths } from '../lib/paths.js';

const builtInGateways = [huggingfaceGateway, directGateway, ollamaGateway];

export async function loadGateways() {
  const config = await readConfig();
  const loaded = [...builtInGateways];
  for (const packageName of config.gateways ?? []) {
    const imported = await importGatewayPackage(packageName);
    loaded.push(validateGateway(imported.default ?? imported.gateway ?? imported));
  }
  const ids = new Set();
  for (const gateway of loaded) {
    if (ids.has(gateway.id)) throw new Error(`Duplicate gateway id "${gateway.id}".`);
    ids.add(gateway.id);
  }
  return loaded;
}

export async function resolveReference(reference, options = {}) {
  const gateways = await loadGateways();
  const scheme = parseReferenceScheme(reference);
  const gateway = gateways.find((candidate) => candidate.schemes.includes(scheme)) ?? gateways.find((candidate) => candidate.canHandle(reference));
  if (!gateway) throw new Error(`No gateway can resolve "${reference}". Register one with om gateway add <package>.`);
  const context = createGatewayContext({
    reference,
    signal: options.signal,
    credentials: {
      async get(id) {
        if (id === 'huggingface') return process.env.HF_TOKEN;
        return undefined;
      }
    }
  });
  const model = validateResolvedModel(await gateway.resolve(context));
  return { gateway, model };
}

async function importGatewayPackage(packageName) {
  const pluginRequire = createRequire(path.join(getPaths().plugins, 'package.json'));
  try {
    const entryPath = pluginRequire.resolve(packageName);
    return import(pathToFileURL(entryPath).href);
  } catch (pluginError) {
    try {
      return await import(packageName);
    } catch {
      throw new Error(`Gateway package \"${packageName}\" is registered but not installed. Run om gateway add ${packageName}.`, { cause: pluginError });
    }
  }
}
