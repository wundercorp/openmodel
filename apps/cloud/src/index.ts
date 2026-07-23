interface Env {
  AUTH_ISSUER: string;
  AUTH_AUDIENCE: string;
  ALLOWED_ORIGINS: string;
  GATEWAY_REGISTRY?: KVNamespace;
  GPU_CAPACITY_REGISTRY?: KVNamespace;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface JwtPayload {
  iss: string;
  aud?: string | string[];
  client_id?: string;
  azp?: string;
  token_use?: string;
  username?: string;
  "cognito:username"?: string;
  "cognito:groups"?: string[];
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

interface GpuCapacityListing {
  id: string;
  recordType: "GPU_CAPACITY";
  ownerId: string;
  ownerDisplayName: string;
  title: string;
  description: string;
  gpuModel: string;
  gpuCount: number;
  availableGpuCount: number;
  vramGbPerGpu: number;
  allocationMode: string;
  migProfile?: string;
  cudaVersion?: string;
  driverVersion?: string;
  runtime: string;
  connectionMode: string;
  endpointUrl?: string;
  locationLabel: string;
  latitude?: number;
  longitude?: number;
  pricePerGpuHour: number;
  currency: string;
  minimumHours: number;
  maxSessionHours: number;
  checkoutUrl?: string;
  providerInstructions?: string;
  status: string;
  lastHeartbeatAt?: string | null;
  runtimeStatus?: string;
  createdAt: string;
  updatedAt: string;
}

const metadataCache = new Map<string, { expiresAt: number; value: OidcMetadata }>();
const jwksCache = new Map<string, { expiresAt: number; value: JwkWithKid[] }>();
const gpuCapacityPath = "/v1/capacity/gpu";
const supportedAllocationModes = new Set(["EXCLUSIVE", "MIG", "TIME_SLICED"]);
const supportedConnectionModes = new Set(["OPENMODEL_API", "HTTPS_API", "SSH", "WIREGUARD", "TAILSCALE", "MANUAL"]);
const supportedStatuses = new Set(["DRAFT", "PUBLISHED", "PAUSED"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get("origin");
    const corsHeaders = createCorsHeaders(origin, env.ALLOWED_ORIGINS);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = normalizePath(url.pathname);

    try {
      if (request.method === "GET" && path === "/health") {
        return json({
          status: "ok",
          service: "openmodel-cloud",
          apiAliases: ["https://api.openmodel.sh", "https://api.walton.bot"]
        }, 200, corsHeaders);
      }

      if (request.method === "GET" && path === "/v1/gateways") {
        return json({ data: await listGateways(env) }, 200, corsHeaders);
      }

      if (request.method === "GET" && path === gpuCapacityPath) {
        const listings = await listGpuCapacityListings(env);
        return json({
          data: listings.filter((listing) => listing.status === "PUBLISHED"),
          meta: { canonicalApi: "https://api.openmodel.sh", aliasApi: "https://api.walton.bot" }
        }, 200, corsHeaders);
      }

      const user = await authenticate(request, env);

      if (request.method === "GET" && path === "/v1/me") {
        return json({
          id: user.sub,
          email: user.email,
          name: user.name,
          username: user.username ?? user["cognito:username"],
          scope: user.scope,
          permissions: user.permissions ?? [],
          groups: Array.isArray(user["cognito:groups"]) ? user["cognito:groups"] : [],
          clientId: user.client_id ?? user.azp ?? (Array.isArray(user.aud) ? user.aud[0] : user.aud)
        }, 200, corsHeaders);
      }

      if (request.method === "POST" && path === "/v1/gateways") {
        requirePermission(user, "gateways:write");
        const gateway = validateGatewaySubmission(await request.json());
        if (!env.GATEWAY_REGISTRY) {
          return json({ error: "Gateway registry storage is not configured." }, 503, corsHeaders);
        }
        await env.GATEWAY_REGISTRY.put(`gateway:${gateway.id}`, JSON.stringify(gateway));
        return json({ data: gateway }, 201, corsHeaders);
      }

      if (request.method === "GET" && path === `${gpuCapacityPath}/mine`) {
        const listings = await listGpuCapacityListings(env);
        return json({ data: listings.filter((listing) => listing.ownerId === user.sub) }, 200, corsHeaders);
      }

      if (request.method === "POST" && path === gpuCapacityPath) {
        const body = await request.json<Record<string, unknown>>();
        const listing = validateGpuCapacitySubmission(body, {
          id: crypto.randomUUID(),
          ownerId: user.sub,
          ownerDisplayName: String(user.name ?? user.username ?? user["cognito:username"] ?? user.email ?? "OpenModel provider"),
          status: body.publish === true ? "PUBLISHED" : "DRAFT"
        });
        await saveGpuCapacityListing(env, listing, true);
        return json({ data: listing }, 201, corsHeaders);
      }

      const listingRoute = matchGpuCapacityListingRoute(path);
      if (listingRoute) {
        const existing = await readGpuCapacityListing(env, listingRoute.id);
        if (!existing) {
          throw new HttpError(404, "GPU capacity listing was not found.");
        }
        if (existing.ownerId !== user.sub) {
          throw new HttpError(403, "Only the listing owner can change this GPU capacity.");
        }

        if (request.method === "GET" && !listingRoute.action) {
          return json({ data: existing }, 200, corsHeaders);
        }

        if (request.method === "PUT" && !listingRoute.action) {
          const body = await request.json<Record<string, unknown>>();
          const updated = validateGpuCapacitySubmission({ ...existing, ...body }, {
            id: existing.id,
            ownerId: existing.ownerId,
            ownerDisplayName: existing.ownerDisplayName,
            status: String(body.status ?? existing.status),
            createdAt: existing.createdAt
          });
          await saveGpuCapacityListing(env, updated, false);
          return json({ data: updated }, 200, corsHeaders);
        }

        if (request.method === "POST" && listingRoute.action === "publish") {
          const updated = validateGpuCapacitySubmission({ ...existing, status: "PUBLISHED" }, {
            id: existing.id,
            ownerId: existing.ownerId,
            ownerDisplayName: existing.ownerDisplayName,
            status: "PUBLISHED",
            createdAt: existing.createdAt
          });
          await saveGpuCapacityListing(env, updated, false);
          return json({ data: updated }, 200, corsHeaders);
        }

        if (request.method === "POST" && listingRoute.action === "pause") {
          const updated = { ...existing, status: "PAUSED", updatedAt: new Date().toISOString() };
          await saveGpuCapacityListing(env, updated, false);
          return json({ data: updated }, 200, corsHeaders);
        }

        if (request.method === "POST" && listingRoute.action === "heartbeat") {
          const body = await readOptionalJson(request);
          const availableGpuCount = body.availableGpuCount === undefined
            ? existing.availableGpuCount
            : requirePositiveInteger(body.availableGpuCount, "availableGpuCount", { allowZero: true });
          if (availableGpuCount > existing.gpuCount) {
            throw new HttpError(400, "availableGpuCount cannot exceed gpuCount.");
          }
          const updated = {
            ...existing,
            availableGpuCount,
            lastHeartbeatAt: new Date().toISOString(),
            runtimeStatus: normalizeOptionalString(body.runtimeStatus) ?? existing.runtimeStatus,
            updatedAt: new Date().toISOString()
          };
          await saveGpuCapacityListing(env, updated, false);
          return json({ data: updated }, 200, corsHeaders);
        }
      }

      return json({ error: "Not found" }, 404, corsHeaders);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Internal error";
      return json({ error: message }, status, corsHeaders);
    }
  }
};

async function listGpuCapacityListings(env: Env) {
  if (!env.GPU_CAPACITY_REGISTRY) {
    throw new HttpError(503, "GPU capacity storage is not configured. Bind GPU_CAPACITY_REGISTRY.");
  }
  const keys = await env.GPU_CAPACITY_REGISTRY.list({ prefix: "gpu-capacity:" });
  const records = await Promise.all(keys.keys.map(async (key) => {
    const value = await env.GPU_CAPACITY_REGISTRY!.get(key.name);
    return value ? JSON.parse(value) as GpuCapacityListing : undefined;
  }));
  return records
    .filter((record): record is GpuCapacityListing => Boolean(record))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function readGpuCapacityListing(env: Env, id: string) {
  if (!env.GPU_CAPACITY_REGISTRY) {
    throw new HttpError(503, "GPU capacity storage is not configured. Bind GPU_CAPACITY_REGISTRY.");
  }
  const value = await env.GPU_CAPACITY_REGISTRY.get(`gpu-capacity:${id}`);
  return value ? JSON.parse(value) as GpuCapacityListing : undefined;
}

async function saveGpuCapacityListing(env: Env, listing: GpuCapacityListing, requireNew: boolean) {
  if (!env.GPU_CAPACITY_REGISTRY) {
    throw new HttpError(503, "GPU capacity storage is not configured. Bind GPU_CAPACITY_REGISTRY.");
  }
  const key = `gpu-capacity:${listing.id}`;
  if (requireNew && await env.GPU_CAPACITY_REGISTRY.get(key)) {
    throw new HttpError(409, "A GPU capacity listing with that id already exists.");
  }
  await env.GPU_CAPACITY_REGISTRY.put(key, JSON.stringify(listing));
}

function validateGpuCapacitySubmission(
  input: Record<string, unknown>,
  identity: {
    id: string;
    ownerId: string;
    ownerDisplayName: string;
    status: string;
    createdAt?: string;
  }
): GpuCapacityListing {
  const gpuCount = requirePositiveInteger(input.gpuCount, "gpuCount");
  const availableGpuCount = input.availableGpuCount === undefined
    ? gpuCount
    : requirePositiveInteger(input.availableGpuCount, "availableGpuCount", { allowZero: true });
  if (availableGpuCount > gpuCount) {
    throw new HttpError(400, "availableGpuCount cannot exceed gpuCount.");
  }

  const vramGbPerGpu = requirePositiveNumber(input.vramGbPerGpu, "vramGbPerGpu");
  const pricePerGpuHour = requirePositiveNumber(input.pricePerGpuHour, "pricePerGpuHour", { allowZero: true });
  const allocationMode = String(input.allocationMode ?? "EXCLUSIVE").trim().toUpperCase();
  if (!supportedAllocationModes.has(allocationMode)) {
    throw new HttpError(400, `allocationMode must be one of ${[...supportedAllocationModes].join(", ")}.`);
  }

  const connectionMode = String(input.connectionMode ?? "OPENMODEL_API").trim().toUpperCase();
  if (!supportedConnectionModes.has(connectionMode)) {
    throw new HttpError(400, `connectionMode must be one of ${[...supportedConnectionModes].join(", ")}.`);
  }

  const status = String(identity.status ?? input.status ?? "DRAFT").trim().toUpperCase();
  if (!supportedStatuses.has(status)) {
    throw new HttpError(400, `status must be one of ${[...supportedStatuses].join(", ")}.`);
  }

  const endpointUrl = normalizeOptionalUrl(input.endpointUrl, "endpointUrl");
  if (status === "PUBLISHED" && connectionMode === "OPENMODEL_API" && !endpointUrl) {
    throw new HttpError(400, "endpointUrl is required to publish OPENMODEL_API capacity.");
  }

  return {
    id: identity.id,
    recordType: "GPU_CAPACITY",
    ownerId: identity.ownerId,
    ownerDisplayName: identity.ownerDisplayName,
    title: requireString(input.title, "title"),
    description: normalizeOptionalString(input.description) ?? "",
    gpuModel: requireString(input.gpuModel, "gpuModel"),
    gpuCount,
    availableGpuCount,
    vramGbPerGpu,
    allocationMode,
    migProfile: normalizeOptionalString(input.migProfile),
    cudaVersion: normalizeOptionalString(input.cudaVersion),
    driverVersion: normalizeOptionalString(input.driverVersion),
    runtime: normalizeOptionalString(input.runtime) ?? "OpenModel",
    connectionMode,
    endpointUrl,
    locationLabel: normalizeOptionalString(input.locationLabel) ?? "Location shared after purchase",
    latitude: normalizeOptionalCoordinate(input.latitude, -90, 90, "latitude"),
    longitude: normalizeOptionalCoordinate(input.longitude, -180, 180, "longitude"),
    pricePerGpuHour,
    currency: String(input.currency ?? "USD").trim().toUpperCase(),
    minimumHours: requirePositiveNumber(input.minimumHours ?? 1, "minimumHours"),
    maxSessionHours: requirePositiveNumber(input.maxSessionHours ?? 24, "maxSessionHours"),
    checkoutUrl: normalizeOptionalUrl(input.checkoutUrl, "checkoutUrl"),
    providerInstructions: normalizeOptionalString(input.providerInstructions),
    status,
    lastHeartbeatAt: input.lastHeartbeatAt ? String(input.lastHeartbeatAt) : null,
    runtimeStatus: normalizeOptionalString(input.runtimeStatus),
    createdAt: identity.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function matchGpuCapacityListingRoute(path: string) {
  const match = path.match(/^\/v1\/capacity\/gpu\/([^/]+)(?:\/(publish|pause|heartbeat))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
}

async function authenticate(request: Request, env: Env): Promise<JwtPayload> {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) {
    throw new HttpError(401, "A bearer access token is required.");
  }
  const token = authorization.slice("Bearer ".length);
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new HttpError(401, "Malformed access token.");
  }
  const header = decodeJson<JwtHeader>(parts[0]);
  const payload = decodeJson<JwtPayload>(parts[1]);
  if (header.alg !== "RS256") {
    throw new HttpError(401, `Unsupported token algorithm ${header.alg}.`);
  }
  const issuer = env.AUTH_ISSUER.replace(/\/$/, "");
  if (payload.iss.replace(/\/$/, "") !== issuer) {
    throw new HttpError(401, "Token issuer did not match.");
  }
  if (payload.token_use && payload.token_use !== "access") {
    throw new HttpError(401, "An access token is required.");
  }
  const expectedClientIds = env.AUTH_AUDIENCE.split(",").map((value) => value.trim()).filter(Boolean);
  const presentedClientId = typeof payload.client_id === "string"
    ? payload.client_id
    : typeof payload.azp === "string"
      ? payload.azp
      : undefined;
  if (!presentedClientId || !expectedClientIds.includes(presentedClientId)) {
    throw new HttpError(401, "Token was issued for a different Cognito app client. Sign out and sign in again.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    throw new HttpError(401, "Access token has expired.");
  }
  if (payload.nbf && payload.nbf > now + 30) {
    throw new HttpError(401, "Access token is not active yet.");
  }
  const metadata = await getMetadata(issuer);
  const keys = await getJwks(metadata.jwks_uri);
  const key = keys.find((candidate) => candidate.kid === header.kid && candidate.kty === "RSA");
  if (!key) {
    throw new HttpError(401, "Token signing key was not found.");
  }
  const cryptoKey = await crypto.subtle.importKey("jwk", key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, decodeBase64Url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) {
    throw new HttpError(401, "Access token signature was invalid.");
  }
  return payload;
}

async function getMetadata(issuer: string) {
  const cached = metadataCache.get(issuer);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) {
    throw new HttpError(503, "Identity provider discovery failed.");
  }
  const value = await response.json<OidcMetadata>();
  metadataCache.set(issuer, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
  return value;
}

async function getJwks(jwksUri: string) {
  const cached = jwksCache.get(jwksUri);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const response = await fetch(jwksUri);
  if (!response.ok) {
    throw new HttpError(503, "Identity provider signing keys could not be loaded.");
  }
  const value = await response.json<{ keys: JwkWithKid[] }>();
  jwksCache.set(jwksUri, { value: value.keys, expiresAt: Date.now() + 15 * 60 * 1000 });
  return value.keys;
}

async function listGateways(env: Env) {
  const builtIn = [
    { id: "huggingface", name: "Hugging Face", schemes: ["hf"], capabilities: ["resolve", "download", "auth"] },
    { id: "direct", name: "Direct HTTPS", schemes: ["http", "https"], capabilities: ["resolve", "download"] },
    { id: "ollama", name: "Ollama Registry", schemes: ["ollama"], capabilities: ["resolve", "native-pull"] }
  ];
  if (!env.GATEWAY_REGISTRY) {
    return builtIn;
  }
  const keys = await env.GATEWAY_REGISTRY.list({ prefix: "gateway:" });
  const contributed = await Promise.all(keys.keys.map(async (key) => JSON.parse((await env.GATEWAY_REGISTRY!.get(key.name)) ?? "null")));
  return [...builtIn, ...contributed.filter(Boolean)];
}

function validateGatewaySubmission(input: unknown) {
  if (!input || typeof input !== "object") {
    throw new HttpError(400, "Gateway submission must be an object.");
  }
  const value = input as Record<string, unknown>;
  const id = requireString(value.id, "id");
  const name = requireString(value.name, "name");
  const packageName = requireString(value.packageName, "packageName");
  const repository = requireString(value.repository, "repository");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    throw new HttpError(400, "Gateway id is invalid.");
  }
  if (!packageName.includes("openmodel-gateway")) {
    throw new HttpError(400, "Gateway package name must clearly identify itself as an OpenModel gateway.");
  }
  return { id, name, packageName, repository, apiVersion: 1, submittedAt: new Date().toISOString() };
}

function requireString(value: unknown, field: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HttpError(400, `${field} is required.`);
  }
  return value.trim();
}

function requirePositiveInteger(value: unknown, field: string, options: { allowZero?: boolean } = {}) {
  const numericValue = Number(value);
  const minimum = options.allowZero ? 0 : 1;
  if (!Number.isInteger(numericValue) || numericValue < minimum) {
    throw new HttpError(400, `${field} must be an integer greater than or equal to ${minimum}.`);
  }
  return numericValue;
}

function requirePositiveNumber(value: unknown, field: string, options: { allowZero?: boolean } = {}) {
  const numericValue = Number(value);
  const minimum = options.allowZero ? 0 : Number.EPSILON;
  if (!Number.isFinite(numericValue) || numericValue < minimum) {
    throw new HttpError(400, `${field} must be ${options.allowZero ? "zero or greater" : "greater than zero"}.`);
  }
  return numericValue;
}

function normalizeOptionalString(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

function normalizeOptionalUrl(value: unknown, field: string) {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    if (!["https:", "http:"].includes(parsed.protocol)) {
      throw new Error("Unsupported protocol");
    }
    return parsed.toString().replace(/\/$/, "");
  } catch {
    throw new HttpError(400, `${field} must be a valid HTTP or HTTPS URL.`);
  }
}

function normalizeOptionalCoordinate(value: unknown, minimum: number, maximum: number, field: string) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue < minimum || numericValue > maximum) {
    throw new HttpError(400, `${field} must be between ${minimum} and ${maximum}.`);
  }
  return Number(numericValue.toFixed(5));
}

function requirePermission(payload: JwtPayload, permission: string) {
  const permissions = payload.permissions ?? [];
  const scopes = String(payload.scope ?? "").split(/\s+/).filter(Boolean);
  const hasScope = scopes.some((scope) => scope === permission || scope.endsWith(`/${permission}`));
  if (!permissions.includes(permission) && !hasScope) {
    throw new HttpError(403, `Permission ${permission} is required.`);
  }
}

async function readOptionalJson(request: Request) {
  const text = await request.text();
  if (!text.trim()) {
    return {} as Record<string, unknown>;
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "The request body must contain valid JSON.");
  }
}

function normalizePath(path: string) {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function createCorsHeaders(origin: string | null, allowedOriginsValue: string) {
  const defaultOrigins = ["https://openmodel.sh", "https://www.openmodel.sh", "https://walton.bot", "https://www.walton.bot"];
  const allowedOrigins = [...new Set([
    ...allowedOriginsValue.split(",").map((value) => value.trim()).filter(Boolean),
    ...defaultOrigins
  ])];
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] ?? "*";
  return {
    "access-control-allow-origin": allowedOrigin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-max-age": "86400",
    "vary": "origin"
  };
}

function json(value: unknown, status: number, headers: Record<string, string>) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8" }
  });
}

function decodeJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(decodeBase64Url(value))) as T;
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
