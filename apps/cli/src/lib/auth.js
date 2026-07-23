import { getPaths } from './paths.js';
import { readJson, writeJson } from './json-store.js';

function authSettings() {
  return {
    issuer: (process.env.OPENMODEL_AUTH_ISSUER ?? 'https://auth.wundercorp.co').replace(/\/$/, ''),
    clientId: process.env.OPENMODEL_AUTH_CLIENT_ID ?? 'openmodel-cli',
    audience: process.env.OPENMODEL_AUTH_AUDIENCE ?? 'https://api.openmodel.sh',
    cloudApiUrl: (process.env.OPENMODEL_CLOUD_API_URL ?? 'https://api.openmodel.sh').replace(/\/$/, '')
  };
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
}

function accessTokenExpiresAt(auth) {
  const expirationSeconds = Number(decodeJwtPayload(auth.access_token)?.exp);
  if (Number.isFinite(expirationSeconds)) return expirationSeconds * 1000;
  const obtainedAt = Number(auth.obtained_at);
  const expiresIn = Number(auth.expires_in);
  if (Number.isFinite(obtainedAt) && Number.isFinite(expiresIn)) return obtainedAt + expiresIn * 1000;
  return 0;
}

async function discover() {
  const settings = authSettings();
  const response = await fetch(`${settings.issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`OIDC discovery failed with HTTP ${response.status}.`);
  return { settings, metadata: await response.json() };
}

export async function login() {
  const { settings, metadata } = await discover();
  if (!metadata.device_authorization_endpoint) throw new Error('The configured identity provider does not advertise a device authorization endpoint.');
  const deviceResponse = await fetch(metadata.device_authorization_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.clientId, scope: 'openid profile email offline_access', audience: settings.audience })
  });
  if (!deviceResponse.ok) throw new Error(`Device authorization failed with HTTP ${deviceResponse.status}.`);
  const device = await deviceResponse.json();
  process.stdout.write(`Open ${device.verification_uri_complete ?? device.verification_uri}\n`);
  if (device.user_code) process.stdout.write(`Enter code: ${device.user_code}\n`);
  const startedAt = Date.now();
  let interval = Number(device.interval ?? 5) * 1000;
  while (Date.now() - startedAt < Number(device.expires_in ?? 600) * 1000) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const tokenResponse = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: device.device_code, client_id: settings.clientId })
    });
    const token = await tokenResponse.json();
    if (tokenResponse.ok) {
      const paths = getPaths();
      await writeJson(paths.auth, { ...token, obtained_at: Date.now(), issuer: settings.issuer, client_id: settings.clientId });
      process.stdout.write('Authentication complete.\n');
      return token;
    }
    if (token.error === 'authorization_pending') continue;
    if (token.error === 'slow_down') { interval += 5000; continue; }
    throw new Error(token.error_description ?? token.error ?? 'Authentication failed.');
  }
  throw new Error('Device authorization expired.');
}

export async function getValidAccessToken() {
  const settings = authSettings();
  const paths = getPaths();
  const auth = await readJson(paths.auth, {});
  if (!auth.access_token) throw new Error('Not authenticated. Run om login.');
  if (accessTokenExpiresAt(auth) > Date.now() + 60_000) return auth.access_token;
  if (!auth.refresh_token) {
    await writeJson(paths.auth, {});
    throw new Error('Authentication expired. Run om login again.');
  }

  const { metadata } = await discover();
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: settings.clientId,
      refresh_token: auth.refresh_token
    })
  });
  const token = await response.json().catch(() => ({}));
  if (!response.ok || !token.access_token) {
    await writeJson(paths.auth, {});
    throw new Error(token.error_description ?? token.error ?? 'Authentication refresh failed. Run om login again.');
  }

  const refreshedAuth = {
    ...auth,
    ...token,
    refresh_token: token.refresh_token ?? auth.refresh_token,
    obtained_at: Date.now(),
    issuer: settings.issuer,
    client_id: settings.clientId
  };
  await writeJson(paths.auth, refreshedAuth);
  return refreshedAuth.access_token;
}

export async function logout() {
  const paths = getPaths();
  await writeJson(paths.auth, {});
  process.stdout.write('Local authentication tokens removed.\n');
}

export async function whoami() {
  const settings = authSettings();
  const accessToken = await getValidAccessToken();
  const response = await fetch(`${settings.cloudApiUrl}/v1/me`, { headers: { authorization: `Bearer ${accessToken}` } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof payload.error === 'string'
      ? payload.error
      : typeof payload.message === 'string'
        ? payload.message
        : `Cloud API returned HTTP ${response.status}.`;
    throw new Error(message);
  }
  return payload;
}
