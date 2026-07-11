import { getPaths } from './paths.js';
import { readJson } from './json-store.js';

function settings() {
  return {
    baseUrl: (process.env.OPENMODEL_PRICING_API_URL ?? 'https://api.wundership.com/openmodel/v1').replace(/\/$/, ''),
    timeoutMs: Math.max(1000, Number(process.env.OPENMODEL_PRICING_TIMEOUT_MS ?? 10000))
  };
}

async function accessToken() {
  const auth = await readJson(getPaths().auth, {});
  return auth.access_token;
}

async function request(path, options = {}) {
  const token = await accessToken();
  if (!token) throw new Error('Wundership pricing requires authentication. Run om login.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), settings().timeoutMs);
  try {
    const response = await fetch(`${settings().baseUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'openmodel-cli',
        ...(options.headers ?? {})
      }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message ?? `Wundership pricing API returned HTTP ${response.status}.`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

export async function estimateCloudCost(input) {
  return request('/pricing/estimate', { method: 'POST', body: JSON.stringify(input) });
}

export async function submitUsageEvents(events) {
  return request('/usage/events', { method: 'POST', body: JSON.stringify({ events }) });
}

export async function fetchUsageSummary() {
  return request('/usage/summary');
}
