import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getValidAccessToken } from '../src/lib/auth.js';

function jwtWithExpiration(expirationSeconds) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expirationSeconds })).toString('base64url');
  return `${header}.${payload}.signature`;
}

test('refreshes an expired CLI access token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'openmodel-auth-'));
  const previousHome = process.env.OPENMODEL_HOME;
  const previousIssuer = process.env.OPENMODEL_AUTH_ISSUER;
  const previousClientId = process.env.OPENMODEL_AUTH_CLIENT_ID;
  const previousFetch = globalThis.fetch;
  process.env.OPENMODEL_HOME = directory;
  process.env.OPENMODEL_AUTH_ISSUER = 'https://identity.example.com';
  process.env.OPENMODEL_AUTH_CLIENT_ID = 'cli-client-id';
  const expiredToken = jwtWithExpiration(Math.floor(Date.now() / 1000) - 60);
  const refreshedToken = jwtWithExpiration(Math.floor(Date.now() / 1000) + 3600);
  await writeFile(path.join(directory, 'auth.json'), `${JSON.stringify({
    access_token: expiredToken,
    refresh_token: 'refresh-token',
    obtained_at: Date.now() - 7200000,
    expires_in: 3600
  })}
`);
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    if (String(url).endsWith('/.well-known/openid-configuration')) {
      return new Response(JSON.stringify({
        token_endpoint: 'https://identity.example.com/oauth2/token',
        authorization_endpoint: 'https://identity.example.com/oauth2/authorize'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      access_token: refreshedToken,
      expires_in: 3600,
      token_type: 'Bearer'
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    const token = await getValidAccessToken();
    assert.equal(token, refreshedToken);
    assert.equal(requests.length, 2);
    const refreshBody = new URLSearchParams(requests[1].init.body);
    assert.equal(refreshBody.get('grant_type'), 'refresh_token');
    assert.equal(refreshBody.get('client_id'), 'cli-client-id');
    assert.equal(refreshBody.get('refresh_token'), 'refresh-token');
    const stored = JSON.parse(await readFile(path.join(directory, 'auth.json'), 'utf8'));
    assert.equal(stored.access_token, refreshedToken);
    assert.equal(stored.refresh_token, 'refresh-token');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousHome === undefined) delete process.env.OPENMODEL_HOME;
    else process.env.OPENMODEL_HOME = previousHome;
    if (previousIssuer === undefined) delete process.env.OPENMODEL_AUTH_ISSUER;
    else process.env.OPENMODEL_AUTH_ISSUER = previousIssuer;
    if (previousClientId === undefined) delete process.env.OPENMODEL_AUTH_CLIENT_ID;
    else process.env.OPENMODEL_AUTH_CLIENT_ID = previousClientId;
    await rm(directory, { recursive: true, force: true });
  }
});
