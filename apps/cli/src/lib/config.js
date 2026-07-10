import { getPaths } from './paths.js';
import { readJson, writeJson } from './json-store.js';

export async function readConfig() {
  const paths = getPaths();
  return readJson(paths.config, { aliases: {}, gateways: [] });
}

export async function writeConfig(config) {
  const paths = getPaths();
  await writeJson(paths.config, config);
}
