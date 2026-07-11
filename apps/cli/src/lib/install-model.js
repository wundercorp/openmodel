import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { downloadArtifact } from './download.js';
import { getPaths } from './paths.js';
import { findManifest, listManifests, safeModelId, saveManifest, setAlias } from './model-store.js';
import { resolveReference } from '../gateways/registry.js';
import { runtimes } from '../runtimes/index.js';

export async function installModel(reference, options = {}) {
  const alias = typeof options.alias === 'string' && options.alias.trim() ? options.alias.trim() : undefined;
  const signal = options.signal;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

  const existingManifest = await findInstalledReference(reference, alias);
  if (existingManifest) {
    onProgress({
      type: 'complete',
      progress: 100,
      message: `${existingManifest.storedId} is already installed.`,
      manifest: existingManifest
    });
    return existingManifest;
  }

  onProgress({ type: 'resolving', progress: 1, message: 'Resolving model reference.' });
  const { gateway, model } = await resolveReference(reference, { signal });
  const paths = getPaths();
  const modelDirectory = path.join(paths.models, safeModelId(model.id));
  await mkdir(modelDirectory, { recursive: true });

  const artifactPaths = [];
  const artifactCount = model.artifacts.length;
  for (let artifactIndex = 0; artifactIndex < artifactCount; artifactIndex += 1) {
    const artifact = model.artifacts[artifactIndex];
    artifactPaths.push(
      await downloadArtifact(artifact, modelDirectory, {
        signal,
        onProgress(event) {
          const artifactBaseProgress = artifactCount === 0 ? 5 : 5 + (artifactIndex / artifactCount) * 88;
          const artifactProgressRange = artifactCount === 0 ? 88 : 88 / artifactCount;
          const eventProgress = Number.isFinite(event.progress) ? event.progress : 0;
          onProgress({
            ...event,
            progress: Math.min(93, artifactBaseProgress + (eventProgress / 100) * artifactProgressRange),
            artifactIndex,
            artifactCount
          });
        }
      })
    );
  }

  if (model.native?.runtime === 'ollama') {
    const runtime = runtimes.find((candidate) => candidate.id === 'ollama');
    if (!(await runtime.available())) {
      throw new Error('Ollama is required for ollama:// references.');
    }
    onProgress({ type: 'runtime-pull', progress: 70, message: `Pulling ${model.native.model} with Ollama.` });
    await runtime.pull(model.native.model);
  }

  onProgress({ type: 'saving', progress: 96, message: 'Saving the local model manifest.' });
  const manifest = await saveManifest(model, gateway.id, artifactPaths);
  if (alias) {
    await setAlias(alias, manifest.storedId);
  }

  onProgress({
    type: 'complete',
    progress: 100,
    message: `Installed ${manifest.storedId}${alias ? ` as ${alias}` : ''}.`,
    manifest
  });
  return manifest;
}

async function findInstalledReference(reference, alias) {
  if (alias) {
    const aliasManifest = await findManifest(alias);
    if (aliasManifest) {
      return aliasManifest;
    }
  }

  const manifests = await listManifests();
  return manifests.find((manifest) => manifest.model?.source === reference);
}
