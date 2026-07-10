const issuer = (import.meta.env.VITE_AUTH_ISSUER ?? 'https://auth.wundercorp.co').replace(/\/$/, '');
const clientId = import.meta.env.VITE_AUTH_CLIENT_ID ?? 'openmodel-web';
const audience = import.meta.env.VITE_AUTH_AUDIENCE ?? 'https://api.openmodel.sh';
const redirectUri = import.meta.env.VITE_AUTH_REDIRECT_URI ?? `${window.location.origin}/auth/callback`;
const storageKey = 'openmodel:auth';
const verifierKey = 'openmodel:pkce-verifier';

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function discover() {
  const response = await fetch(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error('Identity provider discovery failed.');
  return response.json();
}

export async function beginLogin() {
  const metadata = await discover();
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64Url(new Uint8Array(digest));
  sessionStorage.setItem(verifierKey, verifier);
  const state = base64Url(crypto.getRandomValues(new Uint8Array(24)));
  sessionStorage.setItem(`${verifierKey}:state`, state);
  const url = new URL(metadata.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    audience,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state
  }).toString();
  window.location.assign(url);
}

export async function completeLogin() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get('code');
  if (!code) return false;
  const state = params.get('state');
  if (state !== sessionStorage.getItem(`${verifierKey}:state`)) throw new Error('Authentication state did not match.');
  const verifier = sessionStorage.getItem(verifierKey);
  if (!verifier) throw new Error('PKCE verifier was not found.');
  const metadata = await discover();
  const response = await fetch(metadata.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: clientId, redirect_uri: redirectUri, code_verifier: verifier })
  });
  if (!response.ok) throw new Error('Token exchange failed.');
  sessionStorage.setItem(storageKey, JSON.stringify(await response.json()));
  sessionStorage.removeItem(verifierKey);
  sessionStorage.removeItem(`${verifierKey}:state`);
  window.history.replaceState({}, '', '/');
  return true;
}

export function getSession() {
  const value = sessionStorage.getItem(storageKey);
  return value ? JSON.parse(value) : undefined;
}

export function logout() {
  sessionStorage.removeItem(storageKey);
  window.location.reload();
}
