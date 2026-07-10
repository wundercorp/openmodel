interface Env {
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  ALLOWED_ORIGINS: string;
  GATEWAY_REGISTRY?: KVNamespace;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface JwtPayload {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  nbf?: number;
  iat?: number;
  email?: string;
  name?: string;
  scope?: string;
  permissions?: string[];
  [key: string]: unknown;
}

interface JwkWithKid extends JsonWebKey {
  kid?: string;
}

interface OidcMetadata {
  issuer: string;
  jwks_uri: string;
}

const metadataCache = new Map<string, { expiresAt: number; value: OidcMetadata }>();
const jwksCache = new Map<string, { expiresAt: number; value: JwkWithKid[] }>();

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin');
    const corsHeaders = createCorsHeaders(origin, env.ALLOWED_ORIGINS);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/health') return json({ status: 'ok', service: 'openmodel-cloud' }, 200, corsHeaders);
      if (request.method === 'GET' && url.pathname === '/v1/gateways') return json({ data: await listGateways(env) }, 200, corsHeaders);
      const user = await authenticate(request, env);
      if (request.method === 'GET' && url.pathname === '/v1/me') {
        return json({ id: user.sub, email: user.email, name: user.name, scope: user.scope, permissions: user.permissions ?? [] }, 200, corsHeaders);
      }
      if (request.method === 'POST' && url.pathname === '/v1/gateways') {
        requirePermission(user, 'gateways:write');
        const gateway = validateGatewaySubmission(await request.json());
        if (!env.GATEWAY_REGISTRY) return json({ error: 'Gateway registry storage is not configured.' }, 503, corsHeaders);
        await env.GATEWAY_REGISTRY.put(`gateway:${gateway.id}`, JSON.stringify(gateway));
        return json({ data: gateway }, 201, corsHeaders);
      }
      return json({ error: 'Not found' }, 404, corsHeaders);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Internal error';
      return json({ error: message }, status, corsHeaders);
    }
  }
};

async function authenticate(request: Request, env: Env): Promise<JwtPayload> {
  const authorization = request.headers.get('authorization');
  if (!authorization?.startsWith('Bearer ')) throw new HttpError(401, 'A bearer access token is required.');
  const token = authorization.slice('Bearer '.length);
  const parts = token.split('.');
  if (parts.length !== 3) throw new HttpError(401, 'Malformed access token.');
  const header = decodeJson<JwtHeader>(parts[0]);
  const payload = decodeJson<JwtPayload>(parts[1]);
  if (header.alg !== 'RS256') throw new HttpError(401, `Unsupported token algorithm ${header.alg}.`);
  const issuer = env.AUTH_ISSUER.replace(/\/$/, '');
  if (payload.iss.replace(/\/$/, '') !== issuer) throw new HttpError(401, 'Token issuer did not match.');
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audience.includes(env.AUTH_AUDIENCE)) throw new HttpError(401, 'Token audience did not match.');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new HttpError(401, 'Access token has expired.');
  if (payload.nbf && payload.nbf > now + 30) throw new HttpError(401, 'Access token is not active yet.');
  const metadata = await getMetadata(issuer);
  const keys = await getJwks(metadata.jwks_uri);
  const key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === 'RSA');
  if (!key) throw new HttpError(401, 'Token signing key was not found.');
  const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new HttpError(401, 'Access token signature was invalid.');
  return payload;
}

async function getMetadata(issuer: string) {
  const cached = metadataCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new HttpError(503, 'Identity provider discovery failed.');
  const value = await response.json<OidcMetadata>();
  metadataCache.set(issuer, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

async function getJwks(jwksUri: string) {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const response = await fetch(jwksUri);
  if (!response.ok) throw new HttpError(503, 'Identity provider signing keys could not be loaded.');
  const value = await response.json<{ keys: JwkWithKid[] }>();
  jwksCache.set(jwksUri, { value: value.keys, expiresAt: Date.now() + 15 * 60 * 1000 });
  return value.keys;
}

async function listGateways(env: Env) {
  const builtIn = [
    { id: 'huggingface', name: 'Hugging Face', schemes: ['hf'], capabilities: ['resolve', 'download', 'auth'] },
    { id: 'direct', name: 'Direct HTTPS', schemes: ['http', 'https'], capabilities: ['resolve', 'download'] },
    { id: 'ollama', name: 'Ollama Registry', schemes: ['ollama'], capabilities: ['resolve', 'native-pull'] }
  ];
  if (!env.GATEWAY_REGISTRY) return builtIn;
  const keys = await env.GATEWAY_REGISTRY.list({ prefix: 'gateway:' });
  const contributed = await Promise.all(keys.keys.map(async (key) => JSON.parse((await env.GATEWAY_REGISTRY!.get(key.name)) ?? 'null')));
  return [...builtIn, ...contributed.filter(Boolean)];
}

function validateGatewaySubmission(input: unknown) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'Gateway submission must be an object.');
  const value = input as Record<string, unknown>;
  const id = requireString(value.id, 'id');
  const name = requireString(value.name, 'name');
  const packageName = requireString(value.packageName, 'packageName');
  const repository = requireString(value.repository, 'repository');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new HttpError(400, 'Gateway id is invalid.');
  if (!packageName.includes('openmodel-gateway')) throw new HttpError(400, 'Gateway package name must clearly identify itself as an OpenModel gateway.');
  return { id, name, packageName, repository, apiVersion: 1, submittedAt: new Date().toISOString() };
}

function requireString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new HttpError(400, `${field} is required.`);
  return value.trim();
}

function requirePermission(payload: JwtPayload, permission: string) {
  const permissions = payload.permissions ?? [];
  const scopes = String(payload.scope ?? '').split(/\s+/);
  if (!permissions.includes(permission) && !scopes.includes(permission)) throw new HttpError(403, `Permission ${permission} is required.`);
}

function createCorsHeaders(origin: string | null, allowedOriginsValue: string) {
  const allowedOrigins = allowedOriginsValue.split(',').map((value) => value.trim()).filter(Boolean);
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? '*';
  return {
    'access-control-allow-origin': allowedOrigin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '86400',
    'vary': 'origin'
  };
}

function json(value: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(value), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8' } });
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
