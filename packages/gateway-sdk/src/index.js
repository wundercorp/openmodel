const supportedApiVersions = new Set([1, 2]);
const supportedApiVersion = 2;
const allowedCapabilities = new Set(['resolve', 'download', 'native-pull', 'chat', 'catalog', 'auth', 'infer', 'stream', 'count-tokens', 'usage', 'pricing']);

export class GatewayContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'GatewayContractError';
    this.details = details;
  }
}

function requireNonEmptyString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayContractError(`Gateway field "${fieldName}" must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeStringArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new GatewayContractError(`Gateway field "${fieldName}" must be an array.`);
  }

  return [...new Set(value.map((entry) => requireNonEmptyString(entry, fieldName)))];
}

export function defineGateway(gateway) {
  return validateGateway(gateway);
}

export function validateGateway(gateway) {
  if (!gateway || typeof gateway !== 'object') {
    throw new GatewayContractError('Gateway export must be an object.');
  }

  const normalizedGateway = {
    ...gateway,
    id: requireNonEmptyString(gateway.id, 'id'),
    name: requireNonEmptyString(gateway.name, 'name'),
    apiVersion: gateway.apiVersion,
    schemes: normalizeStringArray(gateway.schemes ?? [], 'schemes').map((scheme) => scheme.toLowerCase()),
    capabilities: normalizeStringArray(gateway.capabilities ?? [], 'capabilities')
  };

  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalizedGateway.id)) {
    throw new GatewayContractError('Gateway id must contain only lowercase letters, numbers, dots, underscores, and hyphens.');
  }

  if (!supportedApiVersions.has(normalizedGateway.apiVersion)) {
    throw new GatewayContractError(`Gateway API version ${normalizedGateway.apiVersion} is not supported. Supported versions: ${[...supportedApiVersions].join(', ')}.`);
  }

  for (const capability of normalizedGateway.capabilities) {
    if (!allowedCapabilities.has(capability)) {
      throw new GatewayContractError(`Unsupported gateway capability "${capability}".`);
    }
  }

  if (typeof normalizedGateway.canHandle !== 'function') {
    throw new GatewayContractError('Gateway must implement canHandle(reference).');
  }

  const supportsResolution = typeof normalizedGateway.resolve === 'function';
  const supportsInference = typeof normalizedGateway.infer === 'function' || typeof normalizedGateway.inferStream === 'function';
  if (!supportsResolution && !supportsInference) {
    throw new GatewayContractError('Gateway must implement resolve(context), infer(context), or inferStream(context).');
  }

  return Object.freeze(normalizedGateway);
}

export function validateResolvedModel(model) {
  if (!model || typeof model !== 'object') {
    throw new GatewayContractError('Gateway resolve() must return an object.');
  }

  const normalizedModel = {
    ...model,
    id: requireNonEmptyString(model.id, 'resolvedModel.id'),
    source: requireNonEmptyString(model.source, 'resolvedModel.source'),
    displayName: requireNonEmptyString(model.displayName ?? model.id, 'resolvedModel.displayName'),
    format: requireNonEmptyString(model.format ?? 'unknown', 'resolvedModel.format'),
    artifacts: Array.isArray(model.artifacts) ? model.artifacts.map(validateArtifact) : [],
    runtimeHints: normalizeStringArray(model.runtimeHints ?? [], 'resolvedModel.runtimeHints')
  };

  if (normalizedModel.artifacts.length === 0 && !normalizedModel.native) {
    throw new GatewayContractError('Resolved model must contain at least one artifact or a native runtime descriptor.');
  }

  if (normalizedModel.native) {
    normalizedModel.native = validateNativeDescriptor(normalizedModel.native);
  }

  return normalizedModel;
}

export function validateArtifact(artifact) {
  if (!artifact || typeof artifact !== 'object') {
    throw new GatewayContractError('Artifact must be an object.');
  }

  const url = new URL(requireNonEmptyString(artifact.url, 'artifact.url'));

  if (!['https:', 'http:', 'file:'].includes(url.protocol)) {
    throw new GatewayContractError(`Artifact URL protocol "${url.protocol}" is not supported.`);
  }

  const normalizedArtifact = {
    ...artifact,
    url: url.toString(),
    fileName: requireNonEmptyString(artifact.fileName, 'artifact.fileName'),
    headers: normalizeHeaders(artifact.headers ?? {})
  };

  if (artifact.sha256 !== undefined) {
    const sha256 = requireNonEmptyString(artifact.sha256, 'artifact.sha256').toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha256)) {
      throw new GatewayContractError('Artifact sha256 must be a 64-character hexadecimal digest.');
    }
    normalizedArtifact.sha256 = sha256;
  }

  return normalizedArtifact;
}

function validateNativeDescriptor(nativeDescriptor) {
  if (!nativeDescriptor || typeof nativeDescriptor !== 'object') {
    throw new GatewayContractError('Native runtime descriptor must be an object.');
  }

  return {
    ...nativeDescriptor,
    runtime: requireNonEmptyString(nativeDescriptor.runtime, 'native.runtime'),
    model: requireNonEmptyString(nativeDescriptor.model, 'native.model')
  };
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) {
    throw new GatewayContractError('Artifact headers must be an object.');
  }

  const normalizedHeaders = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    normalizedHeaders[requireNonEmptyString(headerName, 'artifact.headers.name')] = requireNonEmptyString(headerValue, 'artifact.headers.value');
  }

  return normalizedHeaders;
}

export function parseReferenceScheme(reference) {
  const normalizedReference = requireNonEmptyString(reference, 'reference');
  const schemeMatch = normalizedReference.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  return schemeMatch ? schemeMatch[1].toLowerCase() : '';
}

export function createGatewayContext(options) {
  return {
    reference: requireNonEmptyString(options.reference, 'reference'),
    signal: options.signal,
    fetch: options.fetch ?? globalThis.fetch,
    credentials: options.credentials ?? {
      async get() {
        return undefined;
      }
    },
    logger: options.logger ?? {
      debug() {},
      info() {},
      warn() {},
      error() {}
    }
  };
}

export const gatewayApiVersion = supportedApiVersion;


export function normalizeInferenceUsage(usage = {}, options = {}) {
  const inputTokens = Math.max(0, Number(usage.inputTokens ?? usage.promptTokens ?? 0));
  const outputTokens = Math.max(0, Number(usage.outputTokens ?? usage.completionTokens ?? 0));
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(0, Number(usage.totalTokens ?? inputTokens + outputTokens)),
    cachedInputTokens: Math.max(0, Number(usage.cachedInputTokens ?? 0)),
    cacheWriteTokens: Math.max(0, Number(usage.cacheWriteTokens ?? 0)),
    reasoningTokens: Math.max(0, Number(usage.reasoningTokens ?? 0)),
    dimensions: usage.dimensions && typeof usage.dimensions === 'object' ? usage.dimensions : {},
    source: usage.source ?? options.source ?? 'estimated',
    accuracy: usage.accuracy ?? options.accuracy ?? 'estimated'
  };
}

export function createInferenceResult(input) {
  if (!input || typeof input !== 'object') throw new GatewayContractError('Inference result must be an object.');
  return {
    id: requireNonEmptyString(input.id, 'inference.id'),
    provider: requireNonEmptyString(input.provider, 'inference.provider'),
    model: requireNonEmptyString(input.model, 'inference.model'),
    output: input.output ?? {},
    usage: normalizeInferenceUsage(input.usage),
    timing: input.timing ?? {},
    cost: input.cost ?? null,
    raw: input.raw
  };
}

function finiteNonNegativeNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
}

function splitProviderModel(provider, model) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const normalizedModel = String(model ?? '').trim();
  if (normalizedProvider || !normalizedModel.includes('/')) {
    return {
      provider: normalizedProvider,
      model: normalizedModel
    };
  }
  const separatorIndex = normalizedModel.indexOf('/');
  return {
    provider: normalizedModel.slice(0, separatorIndex).toLowerCase(),
    model: normalizedModel.slice(separatorIndex + 1)
  };
}

export function usageEventFromOpenRouterResponse(response, context = {}) {
  if (!response || typeof response !== 'object') {
    throw new GatewayContractError('OpenRouter response must be an object.');
  }
  const usage = response.usage && typeof response.usage === 'object' ? response.usage : {};
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details
    : {};
  const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object'
    ? usage.completion_tokens_details
    : {};
  const providerModel = splitProviderModel(context.provider, response.model ?? context.model);
  return {
    source: context.source ?? 'openrouter',
    sourceVersion: context.sourceVersion,
    sessionId: context.sessionId,
    requestId: response.id ?? context.requestId,
    provider: providerModel.provider,
    model: providerModel.model,
    region: context.region ?? 'global',
    serviceTier: context.serviceTier ?? 'default',
    status: context.status ?? 'success',
    occurredAt: context.occurredAt ?? new Date().toISOString(),
    durationMs: context.durationMs ?? 0,
    usage: {
      inputTokens: finiteNonNegativeNumber(usage.prompt_tokens),
      outputTokens: finiteNonNegativeNumber(usage.completion_tokens),
      totalTokens: finiteNonNegativeNumber(usage.total_tokens),
      cachedInputTokens: finiteNonNegativeNumber(promptDetails.cached_tokens),
      cacheWriteTokens: finiteNonNegativeNumber(promptDetails.cache_write_tokens),
      reasoningTokens: finiteNonNegativeNumber(completionDetails.reasoning_tokens)
    },
    cost: {
      amount: finiteNonNegativeNumber(usage.cost),
      currency: context.currency ?? 'USD',
      source: 'openrouter-response'
    },
    accuracy: 'exact',
    metadata: {
      generationId: response.id,
      upstreamProvider: context.upstreamProvider
    }
  };
}

export function createUsageReporter(options = {}) {
  const endpoint = String(options.endpoint ?? 'http://127.0.0.1:11435/v1/telemetry/events').replace(/\/$/, '');
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== 'function') {
    throw new GatewayContractError('Usage reporter requires a fetch implementation.');
  }
  return async function reportUsage(event) {
    const response = await fetchImplementation(endpoint, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(options.headers ?? {})
      },
      body: JSON.stringify({
        event: {
          ...event,
          source: event?.source ?? options.source ?? 'gateway-sdk'
        }
      }),
      signal: options.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new GatewayContractError(
        payload.error ?? `OpenModel telemetry endpoint returned HTTP ${response.status}.`,
        { status: response.status, payload }
      );
    }
    return payload.data ?? payload;
  };
}
