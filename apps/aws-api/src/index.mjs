import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const metadataCache = new Map();
const jwksCache = new Map();

const gpuCapacityPath = '/v1/capacity/gpu';
const supportedAllocationModes = new Set(['EXCLUSIVE', 'MIG', 'TIME_SLICED']);
const supportedConnectionModes = new Set(['OPENMODEL_API', 'HTTPS_API', 'SSH', 'WIREGUARD', 'TAILSCALE', 'MANUAL']);
const supportedStatuses = new Set(['DRAFT', 'PUBLISHED', 'PAUSED']);

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const path = normalizePath(event.rawPath ?? event.path ?? '/');
  const headers = normalizeHeaders(event.headers ?? {});
  const corsHeaders = createCorsHeaders(headers.origin ?? null, process.env.ALLOWED_ORIGINS ?? '*');

  if (method === 'OPTIONS') {
    return createResponse(204, null, corsHeaders);
  }

  try {
    if (method === 'GET' && path === '/health') {
      return createResponse(200, {
        status: 'ok',
        service: 'openmodel-aws-api',
        apiAliases: ['https://api.openmodel.sh', 'https://api.walton.bot']
      }, corsHeaders);
    }

    if (method === 'GET' && path === '/v1/gateways') {
      return createResponse(200, { data: await listGateways() }, corsHeaders);
    }

    if (method === 'GET' && path === gpuCapacityPath) {
      const listings = await listGpuCapacityListings();
      return createResponse(200, {
        data: listings.filter((listing) => listing.status === 'PUBLISHED'),
        meta: { canonicalApi: 'https://api.openmodel.sh', aliasApi: 'https://api.walton.bot' }
      }, corsHeaders);
    }

    const user = await authenticate(headers.authorization);

    if (method === 'GET' && path === '/v1/me') {
      return createResponse(200, {
        id: user.sub,
        email: user.email,
        name: user.name,
        username: user.username ?? user['cognito:username'],
        scope: user.scope,
        permissions: user.permissions ?? [],
        groups: Array.isArray(user['cognito:groups']) ? user['cognito:groups'] : [],
        clientId: user.client_id ?? user.azp ?? (Array.isArray(user.aud) ? user.aud[0] : user.aud)
      }, corsHeaders);
    }

    if (method === 'POST' && path === '/v1/gateways') {
      requirePermission(user, 'gateways:write');
      const body = parseJsonBody(event.body, event.isBase64Encoded);
      const gateway = validateGatewaySubmission(body);
      await dynamoDocumentClient.send(new PutCommand({
        TableName: requireEnvironmentVariable('GATEWAY_REGISTRY_TABLE'),
        Item: gateway,
        ConditionExpression: 'attribute_not_exists(id)'
      }));
      return createResponse(201, { data: gateway }, corsHeaders);
    }

    if (method === 'GET' && path === `${gpuCapacityPath}/mine`) {
      const listings = await listGpuCapacityListings();
      return createResponse(200, { data: listings.filter((listing) => listing.ownerId === user.sub) }, corsHeaders);
    }

    if (method === 'POST' && path === gpuCapacityPath) {
      const body = parseJsonBody(event.body, event.isBase64Encoded);
      const listing = validateGpuCapacitySubmission(body, {
        id: randomUUID(),
        ownerId: user.sub,
        ownerDisplayName: user.name ?? user.username ?? user['cognito:username'] ?? user.email ?? 'OpenModel provider',
        status: body.publish === true ? 'PUBLISHED' : 'DRAFT'
      });
      await saveGpuCapacityListing(listing, true);
      return createResponse(201, { data: listing }, corsHeaders);
    }

    const listingRoute = matchGpuCapacityListingRoute(path);
    if (listingRoute) {
      const listings = await listGpuCapacityListings();
      const existing = listings.find((listing) => listing.id === listingRoute.id);
      if (!existing) {
        throw new HttpError(404, 'GPU capacity listing was not found.');
      }
      if (existing.ownerId !== user.sub) {
        throw new HttpError(403, 'Only the listing owner can change this GPU capacity.');
      }

      if (method === 'GET' && !listingRoute.action) {
        return createResponse(200, { data: existing }, corsHeaders);
      }

      if (method === 'PUT' && !listingRoute.action) {
        const body = parseJsonBody(event.body, event.isBase64Encoded);
        const updated = validateGpuCapacitySubmission({ ...existing, ...body }, {
          id: existing.id,
          ownerId: existing.ownerId,
          ownerDisplayName: existing.ownerDisplayName,
          status: body.status ?? existing.status,
          createdAt: existing.createdAt
        });
        await saveGpuCapacityListing(updated, false);
        return createResponse(200, { data: updated }, corsHeaders);
      }

      if (method === 'POST' && listingRoute.action === 'publish') {
        const updated = validateGpuCapacitySubmission({ ...existing, status: 'PUBLISHED' }, {
          id: existing.id,
          ownerId: existing.ownerId,
          ownerDisplayName: existing.ownerDisplayName,
          status: 'PUBLISHED',
          createdAt: existing.createdAt
        });
        await saveGpuCapacityListing(updated, false);
        return createResponse(200, { data: updated }, corsHeaders);
      }

      if (method === 'POST' && listingRoute.action === 'pause') {
        const updated = { ...existing, status: 'PAUSED', updatedAt: new Date().toISOString() };
        await saveGpuCapacityListing(updated, false);
        return createResponse(200, { data: updated }, corsHeaders);
      }

      if (method === 'POST' && listingRoute.action === 'heartbeat') {
        const body = parseJsonBody(event.body, event.isBase64Encoded, {});
        const availableGpuCount = body.availableGpuCount === undefined
          ? existing.availableGpuCount
          : requirePositiveInteger(body.availableGpuCount, 'availableGpuCount', { allowZero: true });
        if (availableGpuCount > existing.gpuCount) {
          throw new HttpError(400, 'availableGpuCount cannot exceed gpuCount.');
        }
        const updated = {
          ...existing,
          availableGpuCount,
          lastHeartbeatAt: new Date().toISOString(),
          runtimeStatus: normalizeOptionalString(body.runtimeStatus) ?? existing.runtimeStatus,
          updatedAt: new Date().toISOString()
        };
        await saveGpuCapacityListing(updated, false);
        return createResponse(200, { data: updated }, corsHeaders);
      }
    }

    return createResponse(404, { error: 'Not found' }, corsHeaders);
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return createResponse(409, { error: 'A record with that id already exists.' }, corsHeaders);
    }
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Internal error';
    return createResponse(status, { error: message }, corsHeaders);
  }
}

async function listGpuCapacityListings() {
  const tableName = process.env.GPU_CAPACITY_TABLE ?? process.env.CAPACITY_TABLE;
  if (!tableName) {
    throw new HttpError(503, 'GPU capacity storage is not configured. Set GPU_CAPACITY_TABLE.');
  }
  const response = await dynamoDocumentClient.send(new ScanCommand({ TableName: tableName }));
  return (response.Items ?? [])
    .filter((item) => item && item.recordType === 'GPU_CAPACITY')
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')));
}

async function saveGpuCapacityListing(listing, requireNew) {
  const tableName = process.env.GPU_CAPACITY_TABLE ?? process.env.CAPACITY_TABLE;
  if (!tableName) {
    throw new HttpError(503, 'GPU capacity storage is not configured. Set GPU_CAPACITY_TABLE.');
  }
  const command = {
    TableName: tableName,
    Item: listing
  };
  if (requireNew) {
    command.ConditionExpression = 'attribute_not_exists(id)';
  }
  await dynamoDocumentClient.send(new PutCommand(command));
}

function validateGpuCapacitySubmission(input, identity) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'GPU capacity submission must be an object.');
  }

  const gpuCount = requirePositiveInteger(input.gpuCount, 'gpuCount');
  const availableGpuCount = input.availableGpuCount === undefined
    ? gpuCount
    : requirePositiveInteger(input.availableGpuCount, 'availableGpuCount', { allowZero: true });
  if (availableGpuCount > gpuCount) {
    throw new HttpError(400, 'availableGpuCount cannot exceed gpuCount.');
  }

  const vramGbPerGpu = requirePositiveNumber(input.vramGbPerGpu, 'vramGbPerGpu');
  const pricePerGpuHour = requirePositiveNumber(input.pricePerGpuHour, 'pricePerGpuHour', { allowZero: true });
  const allocationMode = String(input.allocationMode ?? 'EXCLUSIVE').trim().toUpperCase();
  if (!supportedAllocationModes.has(allocationMode)) {
    throw new HttpError(400, `allocationMode must be one of ${[...supportedAllocationModes].join(', ')}.`);
  }

  const connectionMode = String(input.connectionMode ?? 'OPENMODEL_API').trim().toUpperCase();
  if (!supportedConnectionModes.has(connectionMode)) {
    throw new HttpError(400, `connectionMode must be one of ${[...supportedConnectionModes].join(', ')}.`);
  }

  const status = String(identity.status ?? input.status ?? 'DRAFT').trim().toUpperCase();
  if (!supportedStatuses.has(status)) {
    throw new HttpError(400, `status must be one of ${[...supportedStatuses].join(', ')}.`);
  }

  const createdAt = identity.createdAt ?? new Date().toISOString();
  const updatedAt = new Date().toISOString();
  const endpointUrl = normalizeOptionalUrl(input.endpointUrl, 'endpointUrl');
  if (status === 'PUBLISHED' && connectionMode === 'OPENMODEL_API' && !endpointUrl) {
    throw new HttpError(400, 'endpointUrl is required to publish OPENMODEL_API capacity. Start om serve with a reachable endpoint or choose another handoff method.');
  }

  return {
    id: identity.id,
    recordType: 'GPU_CAPACITY',
    ownerId: identity.ownerId,
    ownerDisplayName: identity.ownerDisplayName,
    title: requireString(input.title, 'title'),
    description: normalizeOptionalString(input.description) ?? '',
    gpuModel: requireString(input.gpuModel, 'gpuModel'),
    gpuCount,
    availableGpuCount,
    vramGbPerGpu,
    allocationMode,
    migProfile: normalizeOptionalString(input.migProfile),
    cudaVersion: normalizeOptionalString(input.cudaVersion),
    driverVersion: normalizeOptionalString(input.driverVersion),
    runtime: normalizeOptionalString(input.runtime) ?? 'OpenModel',
    connectionMode,
    endpointUrl,
    locationLabel: normalizeOptionalString(input.locationLabel) ?? 'Location shared after purchase',
    latitude: normalizeOptionalCoordinate(input.latitude, -90, 90, 'latitude'),
    longitude: normalizeOptionalCoordinate(input.longitude, -180, 180, 'longitude'),
    pricePerGpuHour,
    currency: String(input.currency ?? 'USD').trim().toUpperCase(),
    minimumHours: requirePositiveNumber(input.minimumHours ?? 1, 'minimumHours'),
    maxSessionHours: requirePositiveNumber(input.maxSessionHours ?? 24, 'maxSessionHours'),
    checkoutUrl: normalizeOptionalUrl(input.checkoutUrl, 'checkoutUrl'),
    providerInstructions: normalizeOptionalString(input.providerInstructions),
    status,
    lastHeartbeatAt: input.lastHeartbeatAt ?? null,
    runtimeStatus: normalizeOptionalString(input.runtimeStatus),
    createdAt,
    updatedAt
  };
}

function matchGpuCapacityListingRoute(path) {
  const match = path.match(/^\/v1\/capacity\/gpu\/([^/]+)(?:\/(publish|pause|heartbeat))?$/);
  if (!match) {
    return undefined;
  }
  return { id: decodeURIComponent(match[1]), action: match[2] };
}

async function authenticate(authorizationHeader) {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'A bearer access token is required.');
  }

  const token = authorizationHeader.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new HttpError(401, 'Malformed access token.');
  }

  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (header.alg !== 'RS256') {
    throw new HttpError(401, `Unsupported token algorithm ${header.alg}.`);
  }

  const issuer = requireEnvironmentVariable('AUTH_ISSUER').replace(/\/$/, '');
  if (String(payload.iss ?? '').replace(/\/$/, '') !== issuer) {
    throw new HttpError(401, 'Token issuer did not match.');
  }

  if (payload.token_use && payload.token_use !== 'access') {
    throw new HttpError(401, 'An access token is required.');
  }

  const expectedClientIds = requireEnvironmentVariable('AUTH_AUDIENCE')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const presentedClientId = typeof payload.client_id === 'string'
    ? payload.client_id
    : typeof payload.azp === 'string'
      ? payload.azp
      : undefined;
  if (!presentedClientId || !expectedClientIds.includes(presentedClientId)) {
    throw new HttpError(401, 'Token was issued for a different Cognito app client. Sign out and sign in again.');
  }

  const currentUnixTime = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(payload.exp) || payload.exp <= currentUnixTime) {
    throw new HttpError(401, 'Access token has expired.');
  }
  if (payload.nbf && payload.nbf > currentUnixTime + 30) {
    throw new HttpError(401, 'Access token is not active yet.');
  }

  const metadata = await getMetadata(issuer);
  const keys = await getJwks(metadata.jwks_uri);
  const key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
  if (!key) {
    throw new HttpError(401, 'Token signing key was not found.');
  }

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    key,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    decodeBase64Url(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) {
    throw new HttpError(401, 'Access token signature was invalid.');
  }

  return payload;
}

async function getMetadata(issuer) {
  const cached = metadataCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new HttpError(503, 'Identity provider discovery failed.');
  }

  const value = await response.json();
  metadataCache.set(issuer, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

async function getJwks(jwksUri) {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const response = await fetch(jwksUri);
  if (!response.ok) {
    throw new HttpError(503, 'Identity provider signing keys could not be loaded.');
  }

  const value = await response.json();
  jwksCache.set(jwksUri, { value: value.keys, expiresAt: Date.now() + 15 * 60 * 1000 });
  return value.keys;
}

async function listGateways() {
  const builtInGateways = [
    { id: 'huggingface', name: 'Hugging Face', schemes: ['hf'], capabilities: ['resolve', 'download', 'auth'] },
    { id: 'direct', name: 'Direct HTTPS', schemes: ['http', 'https'], capabilities: ['resolve', 'download'] },
    { id: 'ollama', name: 'Ollama Registry', schemes: ['ollama'], capabilities: ['resolve', 'native-pull'] }
  ];

  const tableName = process.env.GATEWAY_REGISTRY_TABLE;
  if (!tableName) {
    return builtInGateways;
  }

  const response = await dynamoDocumentClient.send(new ScanCommand({ TableName: tableName }));
  return [...builtInGateways, ...(response.Items ?? [])];
}

function validateGatewaySubmission(input) {
  if (!input || typeof input !== 'object') {
    throw new HttpError(400, 'Gateway submission must be an object.');
  }

  const id = requireString(input.id, 'id');
  const name = requireString(input.name, 'name');
  const packageName = requireString(input.packageName, 'packageName');
  const repository = requireString(input.repository, 'repository');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new HttpError(400, 'Gateway id is invalid.');
  }
  if (!packageName.includes('openmodel-gateway')) {
    throw new HttpError(400, 'Gateway package name must clearly identify itself as an OpenModel gateway.');
  }

  return {
    id,
    name,
    packageName,
    repository,
    apiVersion: 1,
    submittedAt: new Date().toISOString()
  };
}

function requirePermission(payload, permission) {
  const permissions = payload.permissions ?? [];
  const scopes = String(payload.scope ?? '').split(/\s+/).filter(Boolean);
  const hasScope = scopes.some((scope) => scope === permission || scope.endsWith(`/${permission}`));
  if (!permissions.includes(permission) && !hasScope) {
    throw new HttpError(403, `Permission ${permission} is required.`);
  }
}

function requireString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new HttpError(400, `${fieldName} is required.`);
  }
  return value.trim();
}

function requirePositiveInteger(value, fieldName, options = {}) {
  const numericValue = Number(value);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(numericValue) || numericValue < minimum) {
    throw new HttpError(400, `${fieldName} must be an integer greater than or equal to ${minimum}.`);
  }
  return numericValue;
}

function requirePositiveNumber(value, fieldName, options = {}) {
  const numericValue = Number(value);
  const minimum = options.allowZero ? 0 : Number.EPSILON;
  if (!Number.isFinite(numericValue) || numericValue < minimum) {
    throw new HttpError(400, `${fieldName} must be ${options.allowZero ? 'zero or greater' : 'greater than zero'}.`);
  }
  return numericValue;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeOptionalUrl(value, fieldName) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Unsupported protocol');
    }
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new HttpError(400, `${fieldName} must be a valid HTTP or HTTPS URL.`);
  }
}

function normalizeOptionalCoordinate(value, minimum, maximum, fieldName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw new HttpError(400, `${fieldName} must be between ${minimum} and ${maximum}.`);
  }
  return Number(numericValue.toFixed(5));
}

function parseJsonBody(body, isBase64Encoded, fallback) {
  if (!body) {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new HttpError(400, 'A JSON request body is required.');
  }
  const decodedBody = isBase64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
  try {
    return JSON.parse(decodedBody);
  } catch {
    throw new HttpError(400, 'The request body must contain valid JSON.');
  }
}

function normalizeHeaders(headers) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

function normalizePath(path) {
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1);
  }
  return path;
}

function createCorsHeaders(origin, allowedOriginsValue) {
  const defaultOrigins = ['https://openmodel.sh', 'https://www.openmodel.sh', 'https://walton.bot', 'https://www.walton.bot'];
  const allowedOrigins = [...new Set([
    ...allowedOriginsValue.split(',').map((value) => value.trim()).filter(Boolean),
    ...defaultOrigins
  ])];
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '*';
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
}

function createResponse(statusCode, value, headers) {
  return {
    statusCode,
    headers: value === null ? headers : { ...headers, 'content-type': 'application/json; charset=utf-8' },
    body: value === null ? '' : JSON.stringify(value)
  };
}

function decodeJson(value) {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value)));
}

function decodeBase64Url(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function requireEnvironmentVariable(variableName) {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Required environment variable ${variableName} is empty.`);
  }
  return value;
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
