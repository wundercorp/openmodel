import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

const dynamoDocumentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const metadataCache = new Map();
const jwksCache = new Map();

export async function handler(event) {
  const method = event.requestContext?.http?.method ?? event.httpMethod ?? 'GET';
  const path = event.rawPath ?? event.path ?? '/';
  const headers = normalizeHeaders(event.headers ?? {});
  const corsHeaders = createCorsHeaders(headers.origin ?? null, process.env.ALLOWED_ORIGINS ?? '*');

  if (method === 'OPTIONS') {
    return createResponse(204, null, corsHeaders);
  }

  try {
    if (method === 'GET' && path === '/health') {
      return createResponse(200, { status: 'ok', service: 'openmodel-aws-api' }, corsHeaders);
    }

    if (method === 'GET' && path === '/v1/gateways') {
      return createResponse(200, { data: await listGateways() }, corsHeaders);
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

    return createResponse(404, { error: 'Not found' }, corsHeaders);
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      return createResponse(409, { error: 'A gateway with that id already exists.' }, corsHeaders);
    }
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : 'Internal error';
    return createResponse(status, { error: message }, corsHeaders);
  }
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

function parseJsonBody(body, isBase64Encoded) {
  if (!body) {
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

function createCorsHeaders(origin, allowedOriginsValue) {
  const allowedOrigins = allowedOriginsValue.split(',').map((value) => value.trim()).filter(Boolean);
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '*';
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
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
