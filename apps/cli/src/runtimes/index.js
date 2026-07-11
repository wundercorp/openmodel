import { llamaCppRuntime } from './llamacpp.js';
import { ollamaRuntime } from './ollama.js';

const runtimes = [llamaCppRuntime, ollamaRuntime];

const runtimeInstallCommands = {
  'llama.cpp': {
    darwin: 'brew install llama.cpp',
    linux: 'brew install llama.cpp',
    win32: 'winget install llama.cpp'
  },
  ollama: {
    darwin: 'brew install --cask ollama',
    linux: 'curl -fsSL https://ollama.com/install.sh | sh',
    win32: 'winget install Ollama.Ollama'
  }
};

export class RuntimeUnavailableError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'RuntimeUnavailableError';
    this.code = 'OPENMODEL_RUNTIME_UNAVAILABLE';
    this.statusCode = 503;
    this.details = details;
  }
}

export function getRuntimeInstallCommand(runtimeId, platform = process.platform) {
  return runtimeInstallCommands[runtimeId]?.[platform];
}

export function getRequiredRuntimeIds(manifest) {
  const runtimeHints = Array.isArray(manifest?.model?.runtimeHints)
    ? manifest.model.runtimeHints
    : [];
  return runtimeHints.filter((runtimeId) => runtimes.some((runtime) => runtime.id === runtimeId));
}

export async function getRuntimeStatus(manifests = []) {
  const runtimeEntries = await Promise.all(
    runtimes.map(async (runtime) => {
      const status = typeof runtime.status === 'function'
        ? await runtime.status()
        : { available: await runtime.available() };
      return {
        id: runtime.id,
        available: Boolean(status.available),
        binary: status.binary,
        installCommand: getRuntimeInstallCommand(runtime.id)
      };
    })
  );

  const models = manifests.map((manifest) => {
    const requiredRuntimeIds = getRequiredRuntimeIds(manifest);
    const availableRuntime = runtimeEntries.find(
      (runtime) => requiredRuntimeIds.includes(runtime.id) && runtime.available
    );
    return {
      id: manifest.storedId,
      format: manifest.model?.format,
      requiredRuntimeIds,
      availableRuntimeId: availableRuntime?.id,
      runnable: Boolean(availableRuntime)
    };
  });

  return {
    platform: process.platform,
    architecture: process.arch,
    runtimes: runtimeEntries,
    models
  };
}

export async function selectRuntime(manifest, requestedRuntime = 'auto') {
  if (requestedRuntime !== 'auto') {
    const runtime = runtimes.find((candidate) => candidate.id === requestedRuntime);
    if (!runtime) throw new Error(`Unknown runtime "${requestedRuntime}".`);
    if (!(await runtime.available())) {
      throw new RuntimeUnavailableError(
        `Runtime "${requestedRuntime}" is not available.`,
        {
          requestedRuntime,
          requiredRuntimeIds: [requestedRuntime],
          installCommand: getRuntimeInstallCommand(requestedRuntime),
          platform: process.platform
        }
      );
    }
    return runtime;
  }

  const requiredRuntimeIds = getRequiredRuntimeIds(manifest);
  for (const runtimeId of requiredRuntimeIds) {
    const runtime = runtimes.find((candidate) => candidate.id === runtimeId);
    if (runtime && await runtime.available()) return runtime;
  }

  const preferredRuntimeId = requiredRuntimeIds[0];
  throw new RuntimeUnavailableError(
    'No compatible runtime is available for this model.',
    {
      modelId: manifest?.storedId,
      requiredRuntimeIds,
      preferredRuntimeId,
      installCommand: preferredRuntimeId
        ? getRuntimeInstallCommand(preferredRuntimeId)
        : undefined,
      platform: process.platform
    }
  );
}

export { runtimes };
