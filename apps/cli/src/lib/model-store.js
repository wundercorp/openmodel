import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getPaths } from './paths.js';
import { readConfig, writeConfig } from './config.js';
import { writeJson } from './json-store.js';

export function safeModelId(value) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'model';
}

export async function saveManifest(model, gatewayId, artifactPaths = []) {
  const paths = getPaths();
  await mkdir(paths.manifests, { recursive: true });
  const storedId = safeModelId(model.id);
  const manifest = {
    schemaVersion: 1,
    storedId,
    gatewayId,
    model,
    artifactPaths,
    createdAt: new Date().toISOString()
  };
  await writeJson(path.join(paths.manifests, `${storedId}.json`), manifest);
  return manifest;
}

export async function listManifests() {
  const paths = getPaths();
  try {
    const files = await readdir(paths.manifests);
    const manifests = [];
    for (const file of files.filter((entry) => entry.endsWith('.json'))) {
      manifests.push(JSON.parse(await readFile(path.join(paths.manifests, file), 'utf8')));
    }
    return manifests.sort((left, right) => left.storedId.localeCompare(right.storedId));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function findManifest(reference) {
  const config = await readConfig();
  const resolvedId = config.aliases?.[reference] ?? reference;
  return (await listManifests()).find((manifest) => manifest.storedId === resolvedId || manifest.model.id === resolvedId || manifest.model.displayName === resolvedId);
}

export async function setAlias(alias, storedId) {
  const config = await readConfig();
  config.aliases = { ...(config.aliases ?? {}), [alias]: storedId };
  await writeConfig(config);
}

export async function removeManifest(reference) {
  const manifest = await findManifest(reference);
  if (!manifest) throw new Error(`Model "${reference}" is not installed.`);
  for (const artifactPath of manifest.artifactPaths ?? []) await rm(artifactPath, { force: true });
  const paths = getPaths();
  await rm(path.join(paths.manifests, `${manifest.storedId}.json`), { force: true });
  const config = await readConfig();
  config.aliases = Object.fromEntries(Object.entries(config.aliases ?? {}).filter(([, value]) => value !== manifest.storedId));
  await writeConfig(config);
  return manifest;
}
