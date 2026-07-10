const supportedApiVersion = 1;
const allowedCapabilities = new Set(['resolve', 'download', 'native-pull', 'chat', 'catalog', 'auth']);

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

  if (normalizedGateway.apiVersion !== supportedApiVersion) {
    throw new GatewayContractError(`Gateway API version ${normalizedGateway.apiVersion} is not supported. Expected ${supportedApiVersion}.`);
  }

  for (const capability of normalizedGateway.capabilities) {
    if (!allowedCapabilities.has(capability)) {
      throw new GatewayContractError(`Unsupported gateway capability "${capability}".`);
    }
  }

  if (typeof normalizedGateway.canHandle !== 'function') {
    throw new GatewayContractError('Gateway must implement canHandle(reference).');
  }

  if (typeof normalizedGateway.resolve !== 'function') {
    throw new GatewayContractError('Gateway must implement resolve(context).');
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
