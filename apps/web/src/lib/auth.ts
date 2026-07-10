export interface AuthSession {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  obtainedAt: number;
  expiresAt: number;
}

export interface AuthUser {
  sub: string;
  email?: string;
  name?: string;
  username?: string;
  groups: string[];
  claims: Record<string, unknown>;
}

export interface LoginCompletion {
  completed: boolean;
  session?: AuthSession;
  returnTo?: string;
}

interface OidcMetadata {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  revocation_endpoint?: string;
  end_session_endpoint?: string;
}

interface LoginRequest {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const issuer = normalizeUrl(import.meta.env.VITE_AUTH_ISSUER ?? "");
const authDomain = normalizeUrl(import.meta.env.VITE_AUTH_DOMAIN ?? "");
const clientId = String(import.meta.env.VITE_AUTH_CLIENT_ID ?? "").trim();
const redirectUri = String(
  import.meta.env.VITE_AUTH_REDIRECT_URI ??
    `${window.location.origin}/auth/callback`,
).trim();
const logoutUri = String(
  import.meta.env.VITE_AUTH_LOGOUT_URI ?? window.location.origin,
).trim();
const resource = String(import.meta.env.VITE_AUTH_RESOURCE ?? "").trim();
const configuredScopes = String(
  import.meta.env.VITE_AUTH_SCOPES ?? "openid profile email",
)
  .split(/[\s,]+/)
  .map((scope) => scope.trim())
  .filter(Boolean);
const storageKey = "openmodel:auth";
const loginRequestKey = "openmodel:auth-request";
const loginRequestMaximumAgeMilliseconds = 15 * 60 * 1000;
let metadataPromise: Promise<OidcMetadata> | undefined;
let loginCompletionPromise: Promise<LoginCompletion> | undefined;

function normalizeUrl(value: string) {
  return value.trim().replace(/\/$/, "");
}

function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBase64Url(value: string) {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return atob(base64);
}

function decodeJwtPayload(token: string | undefined) {
  if (!token) {
    return undefined;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return undefined;
  }

  try {
    const binary = decodeBase64Url(parts[1]);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(
      new TextDecoder().decode(bytes),
    ) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function createRandomValue(length: number) {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function readLoginRequest() {
  const value = sessionStorage.getItem(loginRequestKey);
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as LoginRequest;
  } catch {
    sessionStorage.removeItem(loginRequestKey);
    return undefined;
  }
}

function storeLoginRequest(request: LoginRequest) {
  sessionStorage.setItem(loginRequestKey, JSON.stringify(request));
}

function clearLoginRequest() {
  sessionStorage.removeItem(loginRequestKey);
}

function safeReturnTo(value: string | undefined) {
  if (!value) {
    return "/dashboard";
  }

  try {
    const target = new URL(value, window.location.origin);
    if (target.origin !== window.location.origin) {
      return "/dashboard";
    }
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/dashboard";
  }
}

function createDirectMetadata() {
  if (!authDomain) {
    return undefined;
  }

  return {
    issuer: issuer || undefined,
    authorization_endpoint: `${authDomain}/oauth2/authorize`,
    token_endpoint: `${authDomain}/oauth2/token`,
    userinfo_endpoint: `${authDomain}/oauth2/userInfo`,
    revocation_endpoint: `${authDomain}/oauth2/revoke`,
    end_session_endpoint: `${authDomain}/logout`,
  } satisfies OidcMetadata;
}

async function discover() {
  if (metadataPromise) {
    return metadataPromise;
  }

  metadataPromise = (async () => {
    const directMetadata = createDirectMetadata();
    if (!issuer) {
      if (directMetadata) {
        return directMetadata;
      }
      throw new Error("Authentication issuer is not configured.");
    }

    try {
      const response = await fetch(
        `${issuer}/.well-known/openid-configuration`,
        {
          headers: { accept: "application/json" },
          cache: "no-store",
        },
      );
      if (!response.ok) {
        throw new Error(`OIDC discovery returned HTTP ${response.status}.`);
      }

      const discoveredMetadata = (await response.json()) as OidcMetadata;
      if (!discoveredMetadata.authorization_endpoint) {
        throw new Error("OIDC discovery did not return an authorization endpoint.");
      }
      if (!discoveredMetadata.token_endpoint) {
        throw new Error("OIDC discovery did not return a token endpoint.");
      }

      if (!directMetadata) {
        return discoveredMetadata;
      }

      return {
        ...discoveredMetadata,
        authorization_endpoint: directMetadata.authorization_endpoint,
        token_endpoint: directMetadata.token_endpoint,
        userinfo_endpoint:
          directMetadata.userinfo_endpoint ?? discoveredMetadata.userinfo_endpoint,
        revocation_endpoint:
          directMetadata.revocation_endpoint ??
          discoveredMetadata.revocation_endpoint,
        end_session_endpoint:
          discoveredMetadata.end_session_endpoint ??
          directMetadata.end_session_endpoint,
      };
    } catch (error) {
      if (directMetadata) {
        return directMetadata;
      }
      throw error;
    }
  })();

  return metadataPromise;
}

function requireAuthenticationConfiguration() {
  const configurationError = getAuthConfigurationError();
  if (configurationError) {
    throw new Error(configurationError);
  }
}

function createSession(
  tokenResponse: TokenResponse,
  previousSession?: AuthSession,
) {
  const accessToken = tokenResponse.access_token ?? previousSession?.access_token;
  if (!accessToken) {
    throw new Error("The identity provider did not return an access token.");
  }

  const obtainedAt = Date.now();
  const decodedAccessToken = decodeJwtPayload(accessToken);
  const tokenExpirationSeconds = Number(decodedAccessToken?.exp);
  const fallbackLifetimeSeconds = Number(tokenResponse.expires_in ?? 3600);
  const expiresAt = Number.isFinite(tokenExpirationSeconds)
    ? tokenExpirationSeconds * 1000
    : obtainedAt + fallbackLifetimeSeconds * 1000;

  return {
    access_token: accessToken,
    id_token: tokenResponse.id_token ?? previousSession?.id_token,
    refresh_token:
      tokenResponse.refresh_token ?? previousSession?.refresh_token,
    token_type: tokenResponse.token_type ?? previousSession?.token_type,
    scope: tokenResponse.scope ?? previousSession?.scope,
    expires_in: tokenResponse.expires_in ?? previousSession?.expires_in,
    obtainedAt,
    expiresAt,
  } satisfies AuthSession;
}

function storeSession(session: AuthSession) {
  sessionStorage.setItem(storageKey, JSON.stringify(session));
}

async function exchangeToken(body: URLSearchParams) {
  const metadata = await discover();
  const response = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
    cache: "no-store",
    credentials: "omit",
  });
  const tokenResponse = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || tokenResponse.error) {
    const message =
      tokenResponse.error_description ??
      tokenResponse.error ??
      `Token endpoint returned HTTP ${response.status}.`;
    throw new Error(message);
  }

  return tokenResponse;
}

export function getAuthConfigurationError() {
  if (!clientId) {
    return "VITE_AUTH_CLIENT_ID is not configured.";
  }
  if (clientId === "openmodel-web") {
    return "VITE_AUTH_CLIENT_ID is still set to the app client name. Set it to the generated Cognito app client ID.";
  }
  if (!issuer && !authDomain) {
    return "Set VITE_AUTH_ISSUER to the Cognito user-pool issuer or set VITE_AUTH_DOMAIN to the Cognito hosted domain.";
  }
  if (!redirectUri) {
    return "VITE_AUTH_REDIRECT_URI is not configured.";
  }
  if (configuredScopes.length === 0) {
    return "VITE_AUTH_SCOPES must contain at least one OAuth scope.";
  }
  return undefined;
}

export async function beginLogin(returnTo = "/dashboard") {
  requireAuthenticationConfiguration();
  const metadata = await discover();
  const verifier = createRandomValue(48);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = encodeBase64Url(new Uint8Array(digest));
  const state = createRandomValue(24);
  const nonce = createRandomValue(24);

  storeLoginRequest({
    state,
    nonce,
    verifier,
    returnTo: safeReturnTo(returnTo),
    createdAt: Date.now(),
  });

  const authorizationUrl = new URL(metadata.authorization_endpoint);
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: configuredScopes.join(" "),
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce,
  }).toString();

  if (resource) {
    authorizationUrl.searchParams.set("resource", resource);
  }

  window.location.assign(authorizationUrl);
}

export function completeLogin() {
  if (!loginCompletionPromise) {
    loginCompletionPromise = performCompleteLogin();
  }
  return loginCompletionPromise;
}

async function performCompleteLogin(): Promise<LoginCompletion> {
  const parameters = new URLSearchParams(window.location.search);
  const authorizationError = parameters.get("error");
  const code = parameters.get("code");

  if (authorizationError) {
    const description =
      parameters.get("error_description") ?? authorizationError;
    const request = readLoginRequest();
    clearLoginRequest();
    window.history.replaceState(
      {},
      "",
      safeReturnTo(request?.returnTo ?? "/"),
    );
    throw new Error(description);
  }

  if (!code) {
    return { completed: false };
  }

  requireAuthenticationConfiguration();
  const request = readLoginRequest();
  if (!request) {
    throw new Error("The login request could not be found. Start sign-in again.");
  }
  if (Date.now() - request.createdAt > loginRequestMaximumAgeMilliseconds) {
    clearLoginRequest();
    throw new Error("The login request expired. Start sign-in again.");
  }
  if (parameters.get("state") !== request.state) {
    clearLoginRequest();
    throw new Error("Authentication state did not match.");
  }

  const tokenResponse = await exchangeToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_verifier: request.verifier,
    }),
  );

  const idTokenClaims = decodeJwtPayload(tokenResponse.id_token);
  if (
    idTokenClaims?.nonce &&
    String(idTokenClaims.nonce) !== request.nonce
  ) {
    clearLoginRequest();
    throw new Error("Authentication nonce did not match.");
  }

  const session = createSession(tokenResponse);
  storeSession(session);
  clearLoginRequest();
  const returnTo = safeReturnTo(request.returnTo);
  window.history.replaceState({}, "", returnTo);

  return { completed: true, session, returnTo };
}

export function getSession() {
  const value = sessionStorage.getItem(storageKey);
  if (!value) {
    return undefined;
  }

  try {
    const session = JSON.parse(value) as AuthSession;
    if (!session.access_token || !Number.isFinite(session.expiresAt)) {
      clearSession();
      return undefined;
    }
    if (session.expiresAt <= Date.now() && !session.refresh_token) {
      clearSession();
      return undefined;
    }
    return session;
  } catch {
    clearSession();
    return undefined;
  }
}

export function getSessionUser(session = getSession()) {
  const claims = decodeJwtPayload(session?.id_token);
  if (!claims || typeof claims.sub !== "string") {
    return undefined;
  }

  const rawGroups = claims["cognito:groups"];
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map((group) => String(group))
    : [];

  return {
    sub: claims.sub,
    email: typeof claims.email === "string" ? claims.email : undefined,
    name:
      typeof claims.name === "string"
        ? claims.name
        : typeof claims.email === "string"
          ? claims.email
          : undefined,
    username:
      typeof claims["cognito:username"] === "string"
        ? claims["cognito:username"]
        : typeof claims.preferred_username === "string"
          ? claims.preferred_username
          : undefined,
    groups,
    claims,
  } satisfies AuthUser;
}

export function clearSession() {
  sessionStorage.removeItem(storageKey);
}

export async function refreshSession() {
  requireAuthenticationConfiguration();
  const currentSession = getSession();
  if (!currentSession?.refresh_token) {
    clearSession();
    throw new Error("The session expired. Sign in again.");
  }

  try {
    const tokenResponse = await exchangeToken(
      new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: currentSession.refresh_token,
      }),
    );
    const refreshedSession = createSession(tokenResponse, currentSession);
    storeSession(refreshedSession);
    return refreshedSession;
  } catch (error) {
    clearSession();
    throw error;
  }
}

export async function getValidSession() {
  const session = getSession();
  if (!session) {
    throw new Error("Sign in to continue.");
  }
  if (session.expiresAt > Date.now() + 60_000) {
    return session;
  }
  return refreshSession();
}

export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
) {
  const session = await getValidSession();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${session.access_token}`);
  headers.set("accept", headers.get("accept") ?? "application/json");

  let response = await fetch(input, { ...init, headers });
  if (response.status !== 401 || !session.refresh_token) {
    return response;
  }

  const refreshedSession = await refreshSession();
  headers.set("authorization", `Bearer ${refreshedSession.access_token}`);
  response = await fetch(input, { ...init, headers });
  return response;
}

export async function logout() {
  const currentSession = getSession();
  clearSession();
  clearLoginRequest();

  try {
    const metadata = await discover();
    const logoutEndpoint =
      metadata.end_session_endpoint ??
      (authDomain ? `${authDomain}/logout` : undefined);

    if (!logoutEndpoint) {
      window.location.assign(logoutUri);
      return;
    }

    const url = new URL(logoutEndpoint);
    if (url.pathname.endsWith("/logout")) {
      url.searchParams.set("client_id", clientId);
      url.searchParams.set("logout_uri", logoutUri);
    } else {
      url.searchParams.set("post_logout_redirect_uri", logoutUri);
      if (currentSession?.id_token) {
        url.searchParams.set("id_token_hint", currentSession.id_token);
      }
    }
    window.location.assign(url);
  } catch {
    window.location.assign(logoutUri);
  }
}
