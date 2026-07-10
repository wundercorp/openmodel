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

export async function logout() {
  const paths = getPaths();
  await writeJson(paths.auth, {});
  process.stdout.write('Local authentication tokens removed.\n');
}

export async function whoami() {
  const settings = authSettings();
  const paths = getPaths();
  const auth = await readJson(paths.auth, {});
  if (!auth.access_token) throw new Error('Not authenticated. Run om login.');
  const response = await fetch(`${settings.cloudApiUrl}/v1/me`, { headers: { authorization: `Bearer ${auth.access_token}` } });
  if (!response.ok) throw new Error(`Cloud API returned HTTP ${response.status}.`);
  return response.json();
}
