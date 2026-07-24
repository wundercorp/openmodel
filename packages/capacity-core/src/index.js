export const GPU_LISTING_STATUSES = new Set(['DRAFT', 'PUBLISHED', 'PAUSED']);
export const GPU_ALLOCATION_MODES = new Set(['EXCLUSIVE', 'MIG', 'TIME_SLICED']);
export const GPU_CONNECTION_MODES = new Set(['OPENMODEL_API', 'HTTPS_API', 'SSH', 'WIREGUARD', 'TAILSCALE', 'MANUAL']);
export const PROVIDER_NODE_STATUSES = new Set(['ACTIVE', 'DRAINING', 'DISABLED']);
export const PROVIDER_NODE_HEALTH_STATUSES = new Set(['REGISTERING', 'READY', 'DEGRADED', 'OFFLINE']);
export const RESERVATION_STATUSES = new Set(['ASSIGNED', 'ACCEPTED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'DISPUTED']);
export const TERMINAL_RESERVATION_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED']);
export const EARNING_STATUSES = new Set(['PENDING', 'AVAILABLE', 'PAYOUT_PENDING', 'PAID', 'HELD', 'REVERSED']);
export const PAYOUT_STATUSES = new Set(['REQUESTED', 'PROCESSING', 'PAID', 'FAILED', 'CANCELLED']);
export const PAYOUT_PROFILE_STATUSES = new Set(['PENDING_VERIFICATION', 'VERIFIED', 'ACTIVE', 'REJECTED']);
export const PAYOUT_METHODS = new Set(['STRIPE_CONNECT', 'BANK_TOKEN', 'PAYPAL', 'CRYPTO_WALLET', 'MANUAL']);

export class CapacityContractError extends Error {
  constructor(status, message, code = 'CAPACITY_CONTRACT_ERROR') {
    super(message);
    this.name = 'CapacityContractError';
    this.status = status;
    this.code = code;
  }
}

export function nowIso(now = new Date()) {
  return now instanceof Date ? now.toISOString() : new Date(now).toISOString();
}

export function requireString(value, fieldName, options = {}) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    if (options.optional) return undefined;
    throw new CapacityContractError(400, `${fieldName} is required.`, 'VALIDATION_ERROR');
  }
  const normalized = value.trim();
  const maximumLength = options.maximumLength ?? 2048;
  if (normalized.length > maximumLength) {
    throw new CapacityContractError(400, `${fieldName} must be at most ${maximumLength} characters.`, 'VALIDATION_ERROR');
  }
  return normalized;
}

export function optionalString(value, fieldName, options = {}) {
  if (value === undefined || value === null || value === '') return undefined;
  return requireString(String(value), fieldName, { ...options, optional: true });
}

export function requireInteger(value, fieldName, options = {}) {
  const numericValue = Number(value);
  const minimum = options.minimum ?? 1;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw new CapacityContractError(400, `${fieldName} must be an integer between ${minimum} and ${maximum}.`, 'VALIDATION_ERROR');
  }
  return numericValue;
}

export function requireNumber(value, fieldName, options = {}) {
  const numericValue = Number(value);
  const minimum = options.minimum ?? Number.EPSILON;
  const maximum = options.maximum ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isFinite(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw new CapacityContractError(400, `${fieldName} must be a number between ${minimum} and ${maximum}.`, 'VALIDATION_ERROR');
  }
  return numericValue;
}

export function optionalUrl(value, fieldName) {
  const normalized = optionalString(value, fieldName, { maximumLength: 2048 });
  if (!normalized) return undefined;
  try {
    const parsedUrl = new URL(normalized);
    if (!['https:', 'http:'].includes(parsedUrl.protocol)) throw new Error('unsupported protocol');
    if (parsedUrl.username || parsedUrl.password) {
      throw new CapacityContractError(400, `${fieldName} must not contain embedded credentials.`, 'VALIDATION_ERROR');
    }
    return parsedUrl.toString().replace(/\/$/, '');
  } catch (error) {
    if (error instanceof CapacityContractError) throw error;
    throw new CapacityContractError(400, `${fieldName} must be a valid HTTP or HTTPS URL.`, 'VALIDATION_ERROR');
  }
}

export function normalizeCurrency(value = 'USD') {
  const currency = String(value).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new CapacityContractError(400, 'currency must be a three-letter ISO currency code.', 'VALIDATION_ERROR');
  }
  return currency;
}

export function roundMoney(value) {
  return Number(Number(value).toFixed(6));
}

function normalizeStringArray(value, fieldName, maximumItems = 32) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new CapacityContractError(400, `${fieldName} must be an array.`, 'VALIDATION_ERROR');
  }
  if (value.length > maximumItems) {
    throw new CapacityContractError(400, `${fieldName} must contain at most ${maximumItems} items.`, 'VALIDATION_ERROR');
  }
  return [...new Set(value.map((item) => requireString(String(item), fieldName, { maximumLength: 128 })) )];
}

function normalizeMetadata(value, fieldName = 'metadata') {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new CapacityContractError(400, `${fieldName} must be an object.`, 'VALIDATION_ERROR');
  }
  const safe = {};
  const forbiddenPattern = /(secret|token|password|private.?key|credential|authorization|cookie)/i;
  for (const [key, rawValue] of Object.entries(value)) {
    if (Object.keys(safe).length >= 24) {
      throw new CapacityContractError(400, `${fieldName} must contain at most 24 keys.`, 'VALIDATION_ERROR');
    }
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) {
      throw new CapacityContractError(400, `${fieldName} contains an invalid key.`, 'VALIDATION_ERROR');
    }
    if (forbiddenPattern.test(key)) {
      throw new CapacityContractError(400, `${fieldName} must not contain secrets or credentials.`, 'SENSITIVE_DATA_REJECTED');
    }
    if (!['string', 'number', 'boolean'].includes(typeof rawValue) && rawValue !== null) {
      throw new CapacityContractError(400, `${fieldName}.${key} must be a scalar value.`, 'VALIDATION_ERROR');
    }
    const normalizedValue = typeof rawValue === 'string' ? rawValue.slice(0, 512) : rawValue;
    safe[key] = normalizedValue;
  }
  return safe;
}


export function calculateEffectiveAvailableGpuCount(gpuCount, reportedAvailableGpuCount, reservedGpuCount) {
  const normalizedGpuCount = requireInteger(gpuCount, 'gpuCount', { minimum: 1, maximum: 1024 });
  const normalizedReportedAvailableGpuCount = requireInteger(reportedAvailableGpuCount, 'reportedAvailableGpuCount', { minimum: 0, maximum: normalizedGpuCount });
  const normalizedReservedGpuCount = requireInteger(reservedGpuCount, 'reservedGpuCount', { minimum: 0, maximum: normalizedGpuCount });
  return Math.min(normalizedReportedAvailableGpuCount, Math.max(0, normalizedGpuCount - normalizedReservedGpuCount));
}

export function validateProviderNodeSubmission(input, identity, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapacityContractError(400, 'Provider node submission must be an object.', 'VALIDATION_ERROR');
  }
  const timestamp = nowIso(options.now);
  const gpuCount = requireInteger(input.gpuCount, 'gpuCount', { minimum: 1, maximum: 1024 });
  const availableGpuCount = input.availableGpuCount === undefined
    ? gpuCount
    : requireInteger(input.availableGpuCount, 'availableGpuCount', { minimum: 0, maximum: gpuCount });
  const reservedGpuCount = requireInteger(identity.reservedGpuCount ?? input.reservedGpuCount ?? 0, 'reservedGpuCount', { minimum: 0, maximum: gpuCount });
  const reportedAvailableGpuCount = input.reportedAvailableGpuCount === undefined
    ? availableGpuCount
    : requireInteger(input.reportedAvailableGpuCount, 'reportedAvailableGpuCount', { minimum: 0, maximum: gpuCount });
  const effectiveAvailableGpuCount = calculateEffectiveAvailableGpuCount(gpuCount, reportedAvailableGpuCount, reservedGpuCount);
  const status = String(identity.status ?? input.status ?? 'ACTIVE').trim().toUpperCase();
  if (!PROVIDER_NODE_STATUSES.has(status)) {
    throw new CapacityContractError(400, `status must be one of ${[...PROVIDER_NODE_STATUSES].join(', ')}.`, 'VALIDATION_ERROR');
  }
  const healthStatus = String(input.healthStatus ?? 'REGISTERING').trim().toUpperCase();
  if (!PROVIDER_NODE_HEALTH_STATUSES.has(healthStatus)) {
    throw new CapacityContractError(400, `healthStatus must be one of ${[...PROVIDER_NODE_HEALTH_STATUSES].join(', ')}.`, 'VALIDATION_ERROR');
  }
  return {
    recordType: 'GPU_PROVIDER_NODE',
    id: identity.id,
    ownerId: identity.ownerId,
    ownerDisplayName: identity.ownerDisplayName,
    name: requireString(input.name, 'name', { maximumLength: 120 }),
    status,
    healthStatus,
    gpuModel: requireString(input.gpuModel, 'gpuModel', { maximumLength: 160 }),
    gpuCount,
    availableGpuCount: effectiveAvailableGpuCount,
    reportedAvailableGpuCount,
    reservedGpuCount,
    vramGbPerGpu: requireNumber(input.vramGbPerGpu, 'vramGbPerGpu', { minimum: 0.25, maximum: 1024 }),
    allocationModes: normalizeStringArray(input.allocationModes ?? ['EXCLUSIVE'], 'allocationModes').map((mode) => {
      const normalizedMode = mode.toUpperCase();
      if (!GPU_ALLOCATION_MODES.has(normalizedMode)) {
        throw new CapacityContractError(400, `allocationModes contains unsupported mode ${normalizedMode}.`, 'VALIDATION_ERROR');
      }
      return normalizedMode;
    }),
    runtime: optionalString(input.runtime, 'runtime', { maximumLength: 120 }) ?? 'OpenModel',
    runtimeVersion: optionalString(input.runtimeVersion, 'runtimeVersion', { maximumLength: 120 }),
    driverVersion: optionalString(input.driverVersion, 'driverVersion', { maximumLength: 120 }),
    cudaVersion: optionalString(input.cudaVersion, 'cudaVersion', { maximumLength: 120 }),
    endpointUrl: optionalUrl(input.endpointUrl, 'endpointUrl'),
    region: optionalString(input.region, 'region', { maximumLength: 120 }) ?? 'undisclosed',
    labels: normalizeMetadata(input.labels, 'labels'),
    tokenHash: identity.tokenHash,
    tokenLastFour: identity.tokenLastFour,
    tokenCreatedAt: identity.tokenCreatedAt ?? timestamp,
    lastHeartbeatAt: identity.lastHeartbeatAt ?? null,
    createdAt: identity.createdAt ?? timestamp,
    updatedAt: timestamp,
    revision: requireInteger(identity.revision ?? 1, 'revision', { minimum: 1 })
  };
}

export function sanitizeProviderNode(node) {
  if (!node) return node;
  const { tokenHash, ...safeNode } = node;
  return safeNode;
}

export function applyProviderNodeHeartbeat(node, input = {}, options = {}) {
  if (!node || node.recordType !== 'GPU_PROVIDER_NODE') {
    throw new CapacityContractError(404, 'Provider node was not found.', 'NODE_NOT_FOUND');
  }
  if (node.status === 'DISABLED') {
    throw new CapacityContractError(409, 'Provider node is disabled. Rotate its token or enable it before sending heartbeats.', 'NODE_DISABLED');
  }
  const timestamp = nowIso(options.now);
  const gpuCount = input.gpuCount === undefined
    ? node.gpuCount
    : requireInteger(input.gpuCount, 'gpuCount', { minimum: 1, maximum: 1024 });
  const reservedGpuCount = requireInteger(node.reservedGpuCount ?? 0, 'reservedGpuCount', { minimum: 0, maximum: gpuCount });
  const previousReportedAvailability = node.reportedAvailableGpuCount ?? Math.min(gpuCount, Number(node.availableGpuCount ?? 0) + reservedGpuCount);
  const reportedAvailableGpuCount = input.reportedAvailableGpuCount === undefined && input.availableGpuCount === undefined
    ? requireInteger(previousReportedAvailability, 'reportedAvailableGpuCount', { minimum: 0, maximum: gpuCount })
    : requireInteger(input.reportedAvailableGpuCount ?? input.availableGpuCount, 'availableGpuCount', { minimum: 0, maximum: gpuCount });
  const availableGpuCount = calculateEffectiveAvailableGpuCount(gpuCount, reportedAvailableGpuCount, reservedGpuCount);
  const requestedHealthStatus = String(input.healthStatus ?? input.runtimeStatus ?? 'READY').trim().toUpperCase();
  const healthStatus = PROVIDER_NODE_HEALTH_STATUSES.has(requestedHealthStatus) ? requestedHealthStatus : 'DEGRADED';
  return {
    ...node,
    gpuCount,
    availableGpuCount,
    reportedAvailableGpuCount,
    reservedGpuCount,
    healthStatus,
    runtime: optionalString(input.runtime, 'runtime', { maximumLength: 120 }) ?? node.runtime,
    runtimeVersion: optionalString(input.runtimeVersion, 'runtimeVersion', { maximumLength: 120 }) ?? node.runtimeVersion,
    driverVersion: optionalString(input.driverVersion, 'driverVersion', { maximumLength: 120 }) ?? node.driverVersion,
    cudaVersion: optionalString(input.cudaVersion, 'cudaVersion', { maximumLength: 120 }) ?? node.cudaVersion,
    endpointUrl: input.endpointUrl === undefined ? node.endpointUrl : optionalUrl(input.endpointUrl, 'endpointUrl'),
    labels: input.labels === undefined ? node.labels : normalizeMetadata(input.labels, 'labels'),
    lastHeartbeatAt: timestamp,
    updatedAt: timestamp,
    revision: Number(node.revision ?? 0) + 1
  };
}

export function validateGpuCapacitySubmission(input, identity, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapacityContractError(400, 'GPU capacity submission must be an object.', 'VALIDATION_ERROR');
  }
  const timestamp = nowIso(options.now);
  const gpuCount = requireInteger(input.gpuCount, 'gpuCount', { minimum: 1, maximum: 1024 });
  const availableGpuCount = input.availableGpuCount === undefined
    ? gpuCount
    : requireInteger(input.availableGpuCount, 'availableGpuCount', { minimum: 0, maximum: gpuCount });
  const allocationMode = String(input.allocationMode ?? 'EXCLUSIVE').trim().toUpperCase();
  if (!GPU_ALLOCATION_MODES.has(allocationMode)) {
    throw new CapacityContractError(400, `allocationMode must be one of ${[...GPU_ALLOCATION_MODES].join(', ')}.`, 'VALIDATION_ERROR');
  }
  const connectionMode = String(input.connectionMode ?? 'OPENMODEL_API').trim().toUpperCase();
  if (!GPU_CONNECTION_MODES.has(connectionMode)) {
    throw new CapacityContractError(400, `connectionMode must be one of ${[...GPU_CONNECTION_MODES].join(', ')}.`, 'VALIDATION_ERROR');
  }
  const status = String(identity.status ?? input.status ?? 'DRAFT').trim().toUpperCase();
  if (!GPU_LISTING_STATUSES.has(status)) {
    throw new CapacityContractError(400, `status must be one of ${[...GPU_LISTING_STATUSES].join(', ')}.`, 'VALIDATION_ERROR');
  }
  const workerNodeId = optionalString(input.workerNodeId, 'workerNodeId', { maximumLength: 160 });
  const endpointUrl = optionalUrl(input.endpointUrl, 'endpointUrl');
  if (status === 'PUBLISHED' && connectionMode === 'OPENMODEL_API' && !endpointUrl && !workerNodeId) {
    throw new CapacityContractError(400, 'endpointUrl or workerNodeId is required to publish OPENMODEL_API capacity.', 'LISTING_NOT_ROUTABLE');
  }
  const minimumHours = requireNumber(input.minimumHours ?? 1, 'minimumHours', { minimum: 0.25, maximum: 744 });
  const maxSessionHours = requireNumber(input.maxSessionHours ?? 24, 'maxSessionHours', { minimum: minimumHours, maximum: 744 });
  const pricePerGpuHour = requireNumber(input.pricePerGpuHour, 'pricePerGpuHour', { minimum: 0, maximum: 100000 });
  const platformFeeBps = requireInteger(options.platformFeeBps ?? input.platformFeeBps ?? 1000, 'platformFeeBps', { minimum: 0, maximum: 5000 });
  return {
    recordType: 'GPU_CAPACITY',
    id: identity.id,
    ownerId: identity.ownerId,
    ownerDisplayName: identity.ownerDisplayName,
    workerNodeId,
    title: optionalString(input.title, 'title', { maximumLength: 160 }) ?? `${gpuCount}× ${requireString(input.gpuModel, 'gpuModel', { maximumLength: 160 })}`,
    description: optionalString(input.description, 'description', { maximumLength: 2000 }) ?? '',
    gpuModel: requireString(input.gpuModel, 'gpuModel', { maximumLength: 160 }),
    gpuCount,
    availableGpuCount,
    vramGbPerGpu: requireNumber(input.vramGbPerGpu, 'vramGbPerGpu', { minimum: 0.25, maximum: 1024 }),
    allocationMode,
    migProfile: optionalString(input.migProfile, 'migProfile', { maximumLength: 120 }),
    cudaVersion: optionalString(input.cudaVersion, 'cudaVersion', { maximumLength: 120 }),
    driverVersion: optionalString(input.driverVersion, 'driverVersion', { maximumLength: 120 }),
    runtime: optionalString(input.runtime, 'runtime', { maximumLength: 120 }) ?? 'OpenModel',
    connectionMode,
    endpointUrl,
    locationLabel: optionalString(input.locationLabel, 'locationLabel', { maximumLength: 160 }) ?? 'Location shared after purchase',
    latitude: normalizeCoordinate(input.latitude, -90, 90, 'latitude'),
    longitude: normalizeCoordinate(input.longitude, -180, 180, 'longitude'),
    pricePerGpuHour,
    currency: normalizeCurrency(input.currency),
    minimumHours,
    maxSessionHours,
    checkoutUrl: optionalUrl(input.checkoutUrl, 'checkoutUrl'),
    providerInstructions: optionalString(input.providerInstructions, 'providerInstructions', { maximumLength: 4000 }),
    status,
    managedBy: workerNodeId ? 'HYPERSCALER_MASTER' : 'PROVIDER_HANDOFF',
    platformFeeBps,
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    runtimeStatus: optionalString(input.runtimeStatus, 'runtimeStatus', { maximumLength: 120 }),
    createdAt: identity.createdAt ?? timestamp,
    updatedAt: timestamp,
    revision: requireInteger(identity.revision ?? 1, 'revision', { minimum: 1 })
  };
}

function normalizeCoordinate(value, minimum, maximum, fieldName) {
  if (value === undefined || value === null || value === '') return undefined;
  const numericValue = requireNumber(value, fieldName, { minimum, maximum });
  return Number(numericValue.toFixed(5));
}

export function isHeartbeatFresh(record, maximumAgeSeconds = 120, now = new Date()) {
  if (!record?.lastHeartbeatAt) return false;
  const heartbeatTime = Date.parse(record.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatTime)) return false;
  return heartbeatTime >= new Date(now).getTime() - maximumAgeSeconds * 1000;
}

export function createReservation(input, listing, node, buyer, identity, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapacityContractError(400, 'Reservation submission must be an object.', 'VALIDATION_ERROR');
  }
  if (!listing || listing.recordType !== 'GPU_CAPACITY') {
    throw new CapacityContractError(404, 'GPU capacity listing was not found.', 'LISTING_NOT_FOUND');
  }
  if (listing.status !== 'PUBLISHED') {
    throw new CapacityContractError(409, 'GPU capacity listing is not published.', 'LISTING_UNAVAILABLE');
  }
  if (!listing.workerNodeId) {
    throw new CapacityContractError(409, 'This listing uses provider-managed handoff and cannot be allocated by the hyperscaler master.', 'LISTING_NOT_MASTER_MANAGED');
  }
  if (!node || node.id !== listing.workerNodeId || node.ownerId !== listing.ownerId) {
    throw new CapacityContractError(409, 'The listing worker node is unavailable.', 'NODE_UNAVAILABLE');
  }
  if (node.status !== 'ACTIVE' || node.healthStatus !== 'READY') {
    throw new CapacityContractError(409, 'The provider worker node is not ready for assignments.', 'NODE_UNAVAILABLE');
  }
  const maximumHeartbeatAgeSeconds = options.maximumHeartbeatAgeSeconds ?? 120;
  if (!isHeartbeatFresh(node, maximumHeartbeatAgeSeconds, options.now)) {
    throw new CapacityContractError(409, 'The provider worker node heartbeat is stale.', 'NODE_HEARTBEAT_STALE');
  }
  const allocatableGpuCount = Math.min(Number(listing.availableGpuCount ?? 0), Number(node.availableGpuCount ?? 0));
  if (!Number.isInteger(allocatableGpuCount) || allocatableGpuCount < 1) {
    throw new CapacityContractError(409, 'No GPU capacity is currently available on this provider worker node.', 'CAPACITY_EXHAUSTED');
  }
  const gpuCount = requireInteger(input.gpuCount, 'gpuCount', { minimum: 1, maximum: allocatableGpuCount });
  const requestedHours = requireNumber(input.requestedHours, 'requestedHours', { minimum: listing.minimumHours, maximum: listing.maxSessionHours });
  const fundingReference = requireString(input.fundingReference, 'fundingReference', { maximumLength: 240 });
  const workloadReference = requireString(input.workloadReference, 'workloadReference', { maximumLength: 1024 });
  const workloadKind = optionalString(input.workloadKind, 'workloadKind', { maximumLength: 80 }) ?? 'OPENMODEL_SESSION';
  const timestamp = nowIso(options.now);
  const assignmentTimeoutSeconds = options.assignmentTimeoutSeconds ?? 300;
  const grossAuthorizedAmount = roundMoney(gpuCount * requestedHours * listing.pricePerGpuHour);
  const platformFeeAmount = roundMoney(grossAuthorizedAmount * listing.platformFeeBps / 10000);
  const providerAuthorizedAmount = roundMoney(grossAuthorizedAmount - platformFeeAmount);
  return {
    recordType: 'GPU_RESERVATION',
    id: identity.id,
    clientRequestId: optionalString(input.clientRequestId, 'clientRequestId', { maximumLength: 160 }),
    listingId: listing.id,
    nodeId: node.id,
    providerId: listing.ownerId,
    providerDisplayName: listing.ownerDisplayName,
    buyerId: buyer.sub,
    buyerDisplayName: buyer.name ?? buyer.username ?? buyer.email ?? buyer.sub,
    status: 'ASSIGNED',
    gpuCount,
    requestedHours,
    maxBillableSeconds: Math.floor(requestedHours * 3600),
    pricePerGpuHour: listing.pricePerGpuHour,
    currency: listing.currency,
    platformFeeBps: listing.platformFeeBps,
    grossAuthorizedAmount,
    platformFeeAuthorizedAmount: platformFeeAmount,
    providerAuthorizedAmount,
    fundingReference,
    workloadReference,
    workloadKind,
    workloadMetadata: normalizeMetadata(input.workloadMetadata, 'workloadMetadata'),
    connectionMode: listing.connectionMode,
    endpointUrl: node.endpointUrl ?? listing.endpointUrl,
    providerInstructions: listing.providerInstructions,
    assignmentExpiresAt: new Date(new Date(timestamp).getTime() + assignmentTimeoutSeconds * 1000).toISOString(),
    usageSequence: 0,
    cumulativeBillableSeconds: 0,
    grossAmount: 0,
    platformFeeAmount: 0,
    providerAmount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1
  };
}

export function transitionReservation(reservation, action, input = {}, options = {}) {
  if (!reservation || reservation.recordType !== 'GPU_RESERVATION') {
    throw new CapacityContractError(404, 'Reservation was not found.', 'RESERVATION_NOT_FOUND');
  }
  const normalizedAction = String(action).trim().toLowerCase();
  const timestamp = nowIso(options.now);
  const next = { ...reservation, updatedAt: timestamp, revision: Number(reservation.revision ?? 0) + 1 };
  if (normalizedAction === 'accept') {
    requireReservationStatus(reservation, ['ASSIGNED'], normalizedAction);
    if (Date.parse(reservation.assignmentExpiresAt) <= Date.parse(timestamp)) {
      throw new CapacityContractError(409, 'The assignment has expired.', 'ASSIGNMENT_EXPIRED');
    }
    next.status = 'ACCEPTED';
    next.acceptedAt = timestamp;
    next.providerSessionReference = optionalString(input.providerSessionReference, 'providerSessionReference', { maximumLength: 240 });
    return next;
  }
  if (normalizedAction === 'start') {
    requireReservationStatus(reservation, ['ACCEPTED'], normalizedAction);
    next.status = 'RUNNING';
    next.startedAt = timestamp;
    return next;
  }
  if (normalizedAction === 'complete') {
    requireReservationStatus(reservation, ['RUNNING'], normalizedAction);
    const withUsage = input.cumulativeBillableSeconds === undefined
      ? next
      : applyUsageReport(next, input, options);
    withUsage.status = 'COMPLETED';
    withUsage.completedAt = timestamp;
    withUsage.completionReference = optionalString(input.completionReference, 'completionReference', { maximumLength: 240 });
    return withUsage;
  }
  if (normalizedAction === 'fail') {
    requireReservationStatus(reservation, ['ASSIGNED', 'ACCEPTED', 'RUNNING'], normalizedAction);
    const withUsage = input.cumulativeBillableSeconds === undefined
      ? next
      : applyUsageReport(next, input, options);
    withUsage.status = 'FAILED';
    withUsage.failedAt = timestamp;
    withUsage.failureCode = optionalString(input.failureCode, 'failureCode', { maximumLength: 120 }) ?? 'PROVIDER_FAILURE';
    withUsage.failureMessage = optionalString(input.failureMessage, 'failureMessage', { maximumLength: 1000 });
    return withUsage;
  }
  if (normalizedAction === 'cancel') {
    requireReservationStatus(reservation, ['ASSIGNED', 'ACCEPTED'], normalizedAction);
    next.status = 'CANCELLED';
    next.cancelledAt = timestamp;
    next.cancellationReason = optionalString(input.reason, 'reason', { maximumLength: 500 });
    return next;
  }
  if (normalizedAction === 'expire') {
    requireReservationStatus(reservation, ['ASSIGNED'], normalizedAction);
    if (Date.parse(reservation.assignmentExpiresAt) > Date.parse(timestamp)) {
      throw new CapacityContractError(409, 'The assignment has not expired yet.', 'ASSIGNMENT_NOT_EXPIRED');
    }
    next.status = 'EXPIRED';
    next.expiredAt = timestamp;
    next.expirationReason = optionalString(input.reason, 'reason', { maximumLength: 500 }) ?? 'ASSIGNMENT_TIMEOUT';
    return next;
  }
  if (normalizedAction === 'dispute') {
    requireReservationStatus(reservation, ['COMPLETED', 'FAILED'], normalizedAction);
    next.status = 'DISPUTED';
    next.disputedAt = timestamp;
    next.disputeReason = requireString(input.reason, 'reason', { maximumLength: 1000 });
    return next;
  }
  throw new CapacityContractError(400, `Unsupported reservation action ${normalizedAction}.`, 'INVALID_TRANSITION');
}

function requireReservationStatus(reservation, statuses, action) {
  if (!statuses.includes(reservation.status)) {
    throw new CapacityContractError(409, `Cannot ${action} a reservation in ${reservation.status} state.`, 'INVALID_TRANSITION');
  }
}

export function applyUsageReport(reservation, input, options = {}) {
  requireReservationStatus(reservation, ['RUNNING'], 'report usage for');
  const sequence = requireInteger(input.sequence, 'sequence', { minimum: 1 });
  if (sequence <= Number(reservation.usageSequence ?? 0)) {
    throw new CapacityContractError(409, 'Usage sequence must increase monotonically.', 'DUPLICATE_USAGE_SEQUENCE');
  }
  const cumulativeBillableSeconds = requireInteger(input.cumulativeBillableSeconds, 'cumulativeBillableSeconds', { minimum: 0, maximum: reservation.maxBillableSeconds });
  if (cumulativeBillableSeconds < Number(reservation.cumulativeBillableSeconds ?? 0)) {
    throw new CapacityContractError(409, 'cumulativeBillableSeconds cannot decrease.', 'USAGE_REGRESSION');
  }
  const grossAmount = roundMoney(reservation.gpuCount * cumulativeBillableSeconds / 3600 * reservation.pricePerGpuHour);
  const platformFeeAmount = roundMoney(grossAmount * reservation.platformFeeBps / 10000);
  const providerAmount = roundMoney(grossAmount - platformFeeAmount);
  return {
    ...reservation,
    usageSequence: sequence,
    cumulativeBillableSeconds,
    grossAmount,
    platformFeeAmount,
    providerAmount,
    lastUsageAt: nowIso(options.now),
    updatedAt: nowIso(options.now),
    revision: Number(reservation.revision ?? 0) + 1
  };
}

export function createEarning(reservation, identity, options = {}) {
  if (!reservation || !['COMPLETED', 'FAILED', 'DISPUTED'].includes(reservation.status)) {
    throw new CapacityContractError(409, 'An earning can only be created for a completed, failed, or disputed reservation.', 'EARNING_NOT_READY');
  }
  const timestamp = nowIso(options.now);
  const holdSeconds = options.holdSeconds ?? 7 * 24 * 60 * 60;
  const status = reservation.status === 'COMPLETED' ? 'PENDING' : 'HELD';
  return {
    recordType: 'GPU_EARNING',
    id: identity.id,
    providerId: reservation.providerId,
    reservationId: reservation.id,
    listingId: reservation.listingId,
    status,
    grossAmount: reservation.grossAmount,
    platformFeeAmount: reservation.platformFeeAmount,
    netAmount: reservation.providerAmount,
    currency: reservation.currency,
    availableAt: new Date(new Date(timestamp).getTime() + holdSeconds * 1000).toISOString(),
    payoutId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision: 1
  };
}

export function materializeEarningStatus(earning, options = {}) {
  if (earning.status === 'PENDING' && Date.parse(earning.availableAt) <= new Date(options.now ?? Date.now()).getTime()) {
    return { ...earning, status: 'AVAILABLE', updatedAt: nowIso(options.now), revision: Number(earning.revision ?? 0) + 1 };
  }
  return earning;
}

export function summarizeEarnings(earnings, options = {}) {
  const normalized = earnings.map((earning) => materializeEarningStatus(earning, options));
  const totals = {};
  for (const earning of normalized) {
    const currencyTotals = totals[earning.currency] ?? { pending: 0, available: 0, payoutPending: 0, paid: 0, held: 0, reversed: 0 };
    const key = earning.status === 'PAYOUT_PENDING' ? 'payoutPending' : earning.status.toLowerCase();
    currencyTotals[key] = roundMoney((currencyTotals[key] ?? 0) + earning.netAmount);
    totals[earning.currency] = currencyTotals;
  }
  return { earnings: normalized, totals };
}

export function validatePayoutProfile(input, ownerId, existing, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CapacityContractError(400, 'Payout profile must be an object.', 'VALIDATION_ERROR');
  }
  const method = String(input.method ?? existing?.method ?? '').trim().toUpperCase();
  if (!PAYOUT_METHODS.has(method)) {
    throw new CapacityContractError(400, `method must be one of ${[...PAYOUT_METHODS].join(', ')}.`, 'VALIDATION_ERROR');
  }
  const destinationReference = requireString(input.destinationReference ?? existing?.destinationReference, 'destinationReference', { maximumLength: 240 });
  if (/\s/.test(destinationReference) || destinationReference.length < 4) {
    throw new CapacityContractError(400, 'destinationReference must be a processor-issued token or account reference, never raw banking credentials.', 'VALIDATION_ERROR');
  }
  const timestamp = nowIso(options.now);
  const destinationChanged = Boolean(existing) && (existing.method !== method || existing.destinationReference !== destinationReference);
  const requestedStatus = options.allowStatusOverride
    ? String(input.status ?? existing?.status ?? 'PENDING_VERIFICATION').trim().toUpperCase()
    : String(existing?.status ?? 'PENDING_VERIFICATION').trim().toUpperCase();
  const status = destinationChanged ? 'PENDING_VERIFICATION' : requestedStatus;
  if (!PAYOUT_PROFILE_STATUSES.has(status)) {
    throw new CapacityContractError(400, `status must be one of ${[...PAYOUT_PROFILE_STATUSES].join(', ')}.`, 'VALIDATION_ERROR');
  }
  return {
    recordType: 'GPU_PAYOUT_PROFILE',
    id: `payout-profile:${ownerId}`,
    ownerId,
    method,
    destinationReference,
    destinationLabel: optionalString(input.destinationLabel ?? existing?.destinationLabel, 'destinationLabel', { maximumLength: 160 }),
    status,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    revision: Number(existing?.revision ?? 0) + 1
  };
}

export function createPayout(input, profile, availableEarnings, identity, options = {}) {
  if (!profile) {
    throw new CapacityContractError(409, 'Configure a payout profile before requesting a payout.', 'PAYOUT_PROFILE_REQUIRED');
  }
  if (!['VERIFIED', 'ACTIVE'].includes(profile.status)) {
    throw new CapacityContractError(409, 'The payout profile must be verified by the hyperscaler before payout.', 'PAYOUT_PROFILE_UNVERIFIED');
  }
  const currency = normalizeCurrency(input?.currency ?? 'USD');
  const eligible = availableEarnings.filter((earning) => earning.currency === currency && materializeEarningStatus(earning, options).status === 'AVAILABLE' && !earning.payoutId);
  const availableAmount = roundMoney(eligible.reduce((total, earning) => total + earning.netAmount, 0));
  if (availableAmount <= 0) {
    throw new CapacityContractError(409, `No positive ${currency} earnings are available for payout.`, 'PAYOUT_BALANCE_EMPTY');
  }
  const requestedMinimum = options.minimumPayoutAmount ?? 25;
  const amount = input?.amount === undefined ? availableAmount : requireNumber(input.amount, 'amount', { minimum: Math.max(0.000001, requestedMinimum), maximum: availableAmount });
  if (availableAmount < requestedMinimum) {
    throw new CapacityContractError(409, `At least ${currency} ${(options.minimumPayoutAmount ?? 25).toFixed(2)} must be available before requesting a payout.`, 'PAYOUT_MINIMUM_NOT_MET');
  }
  let remaining = amount;
  const selectedEarnings = [];
  for (const earning of eligible.sort((left, right) => String(left.availableAt).localeCompare(String(right.availableAt)))) {
    if (remaining <= 0.000001) break;
    selectedEarnings.push(earning);
    remaining = roundMoney(remaining - earning.netAmount);
    if (remaining < -0.000001) break;
  }
  if (Math.abs(remaining) > 0.000001) {
    throw new CapacityContractError(409, 'Partial earning allocation is not supported; omit amount to withdraw the full balance or request an amount matching the oldest whole earning records.', 'PAYOUT_AMOUNT_NOT_ALIGNED');
  }
  const timestamp = nowIso(options.now);
  return {
    payout: {
      recordType: 'GPU_PAYOUT',
      id: identity.id,
      providerId: profile.ownerId,
      status: 'REQUESTED',
      currency,
      amount,
      earningIds: selectedEarnings.map((earning) => earning.id),
      destinationMethod: profile.method,
      destinationReference: profile.destinationReference,
      requestedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
      revision: 1
    },
    earnings: selectedEarnings.map((earning) => ({
      ...earning,
      status: 'PAYOUT_PENDING',
      payoutId: identity.id,
      updatedAt: timestamp,
      revision: Number(earning.revision ?? 0) + 1
    }))
  };
}

export function transitionPayout(payout, action, input = {}, options = {}) {
  if (!payout || payout.recordType !== 'GPU_PAYOUT') {
    throw new CapacityContractError(404, 'Payout was not found.', 'PAYOUT_NOT_FOUND');
  }
  const timestamp = nowIso(options.now);
  const normalizedAction = String(action).trim().toLowerCase();
  const next = { ...payout, updatedAt: timestamp, revision: Number(payout.revision ?? 0) + 1 };
  if (normalizedAction === 'processing') {
    if (payout.status !== 'REQUESTED') throw new CapacityContractError(409, 'Only requested payouts can enter processing.', 'INVALID_TRANSITION');
    next.status = 'PROCESSING';
    next.processorReference = optionalString(input.processorReference, 'processorReference', { maximumLength: 240 });
    next.processingAt = timestamp;
    return next;
  }
  if (normalizedAction === 'paid') {
    if (!['REQUESTED', 'PROCESSING'].includes(payout.status)) throw new CapacityContractError(409, 'Only requested or processing payouts can be marked paid.', 'INVALID_TRANSITION');
    next.status = 'PAID';
    next.processorReference = requireString(input.processorReference ?? payout.processorReference, 'processorReference', { maximumLength: 240 });
    next.paidAt = timestamp;
    return next;
  }
  if (normalizedAction === 'failed') {
    if (!['REQUESTED', 'PROCESSING'].includes(payout.status)) throw new CapacityContractError(409, 'Only requested or processing payouts can fail.', 'INVALID_TRANSITION');
    next.status = 'FAILED';
    next.failureCode = optionalString(input.failureCode, 'failureCode', { maximumLength: 120 }) ?? 'PAYOUT_FAILED';
    next.failureMessage = optionalString(input.failureMessage, 'failureMessage', { maximumLength: 1000 });
    next.failedAt = timestamp;
    return next;
  }
  throw new CapacityContractError(400, `Unsupported payout action ${normalizedAction}.`, 'INVALID_TRANSITION');
}
