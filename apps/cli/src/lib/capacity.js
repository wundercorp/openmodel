import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readConfig, writeConfig } from './config.js';
import { getValidAccessToken } from './auth.js';

const execFileAsync = promisify(execFile);

function apiCandidates(flags = {}) {
  const explicitUrl = flags.apiUrl ? String(flags.apiUrl) : undefined;
  const primaryUrl = explicitUrl ?? process.env.OPENMODEL_CLOUD_API_URL ?? 'https://api.openmodel.sh';
  const fallbackUrl = process.env.OPENMODEL_CLOUD_API_FALLBACK_URL ?? 'https://api.walton.bot';
  return [...new Set([primaryUrl, fallbackUrl].map((value) => String(value).trim().replace(/\/$/, '')).filter(Boolean))];
}

async function capacityRequest(path, options = {}) {
  const token = options.auth === false ? undefined : await getValidAccessToken();
  const candidates = apiCandidates({ apiUrl: options.apiUrl });
  const errors = [];

  for (const apiBaseUrl of candidates) {
    try {
      const response = await fetch(`${apiBaseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = typeof payload.error === 'string'
          ? payload.error
          : typeof payload.message === 'string'
            ? payload.message
            : `HTTP ${response.status}`;
        const shouldTryAlias = response.status >= 500 || [401, 403, 404, 408, 421, 425, 429].includes(response.status);
        if (shouldTryAlias && apiBaseUrl !== candidates.at(-1)) {
          errors.push(`${apiBaseUrl}: ${message}`);
          continue;
        }
        if (response.status === 401) {
          const authenticationMessage = /^(forbidden|unauthorized)$/i.test(message)
            ? 'OpenModel authentication was rejected. Run om logout, then om login again.'
            : `${message} Run om logout, then om login again.`;
          throw new Error(authenticationMessage);
        }
        throw new Error(message);
      }
      return { payload, apiBaseUrl };
    } catch (error) {
      errors.push(`${apiBaseUrl}: ${error instanceof Error ? error.message : String(error)}`);
      if (apiBaseUrl === candidates.at(-1)) {
        throw new Error(`GPU capacity API request failed. ${errors.join(' | ')}`);
      }
    }
  }

  throw new Error('GPU capacity API request failed.');
}

export async function detectNvidiaGpus() {
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,driver_version',
      '--format=csv,noheader,nounits'
    ], { encoding: 'utf8' });
    const devices = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, memoryMiB, driverVersion] = line.split(',').map((value) => value.trim());
        return {
          name,
          vramGb: Math.max(1, Math.round(Number(memoryMiB) / 1024)),
          driverVersion
        };
      })
      .filter((device) => device.name && Number.isFinite(device.vramGb));

    if (devices.length === 0) {
      return undefined;
    }

    const firstDevice = devices[0];
    const homogeneousDevices = devices.every((device) => device.name === firstDevice.name && device.vramGb === firstDevice.vramGb);
    return {
      gpuModel: homogeneousDevices ? firstDevice.name : devices.map((device) => device.name).join(' + '),
      gpuCount: devices.length,
      vramGbPerGpu: firstDevice.vramGb,
      driverVersion: firstDevice.driverVersion,
      devices
    };
  } catch {
    return undefined;
  }
}

function requireNumber(value, flagName, fallback) {
  const resolved = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(resolved)) {
    throw new Error(`${flagName} must be a number.`);
  }
  return resolved;
}

function requireInteger(value, flagName, fallback) {
  const resolved = requireNumber(value, flagName, fallback);
  if (!Number.isInteger(resolved)) {
    throw new Error(`${flagName} must be an integer.`);
  }
  return resolved;
}

function stringFlag(flags, name, fallback = '') {
  const value = flags[name];
  return value === undefined || value === true ? fallback : String(value).trim();
}

function booleanFlag(flags, name, fallback = false) {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (value === true) return true;
  return !['false', '0', 'no'].includes(String(value).toLowerCase());
}

function buildListingPayload(flags, detectedGpu) {
  const gpuModel = stringFlag(flags, 'gpu-model', detectedGpu?.gpuModel ?? '');
  const gpuCount = requireInteger(flags['gpus'], '--gpus', detectedGpu?.gpuCount);
  const vramGbPerGpu = requireNumber(flags['vram-gb'], '--vram-gb', detectedGpu?.vramGbPerGpu);
  const pricePerGpuHour = requireNumber(flags['price-hour'], '--price-hour');
  const endpointUrl = stringFlag(flags, 'endpoint');
  const connectionMode = stringFlag(flags, 'connection', endpointUrl ? 'OPENMODEL_API' : 'MANUAL').toUpperCase();

  if (!gpuModel) throw new Error('GPU model was not detected. Pass --gpu-model.');
  if (!gpuCount || gpuCount < 1) throw new Error('GPU count was not detected. Pass --gpus.');
  if (!vramGbPerGpu || vramGbPerGpu <= 0) throw new Error('VRAM was not detected. Pass --vram-gb.');
  if (!Number.isFinite(pricePerGpuHour) || pricePerGpuHour < 0) throw new Error('Pass --price-hour with the USD price for one GPU-hour.');

  return {
    title: stringFlag(flags, 'title', `${gpuCount}× ${gpuModel}`),
    description: stringFlag(flags, 'description', 'GPU capacity exposed through OpenModel.'),
    gpuModel,
    gpuCount,
    availableGpuCount: requireInteger(flags['available-gpus'], '--available-gpus', gpuCount),
    vramGbPerGpu,
    allocationMode: stringFlag(flags, 'allocation', 'EXCLUSIVE').toUpperCase(),
    migProfile: stringFlag(flags, 'mig-profile') || undefined,
    cudaVersion: stringFlag(flags, 'cuda') || undefined,
    driverVersion: stringFlag(flags, 'driver', detectedGpu?.driverVersion ?? '') || undefined,
    runtime: stringFlag(flags, 'runtime', 'OpenModel'),
    connectionMode,
    endpointUrl: endpointUrl || undefined,
    locationLabel: stringFlag(flags, 'location', 'Location shared after purchase'),
    latitude: flags.latitude === undefined ? undefined : requireNumber(flags.latitude, '--latitude'),
    longitude: flags.longitude === undefined ? undefined : requireNumber(flags.longitude, '--longitude'),
    pricePerGpuHour,
    currency: stringFlag(flags, 'currency', 'USD').toUpperCase(),
    minimumHours: requireNumber(flags['minimum-hours'], '--minimum-hours', 1),
    maxSessionHours: requireNumber(flags['max-hours'], '--max-hours', 24),
    checkoutUrl: stringFlag(flags, 'checkout-url') || undefined,
    providerInstructions: stringFlag(flags, 'instructions') || undefined,
    publish: !booleanFlag(flags, 'draft', false)
  };
}

export async function exposeGpuCapacity(flags) {
  const detectedGpu = await detectNvidiaGpus();
  const payload = buildListingPayload(flags, detectedGpu);

  if (booleanFlag(flags, 'dry-run', false)) {
    return { dryRun: true, detectedGpu, payload };
  }

  const { payload: response, apiBaseUrl } = await capacityRequest('/v1/capacity/gpu', {
    method: 'POST',
    body: payload,
    apiUrl: flags['api-url']
  });
  const listing = response.data;
  const config = await readConfig();
  config.capacity = {
    ...(config.capacity ?? {}),
    lastListingId: listing.id,
    apiBaseUrl
  };
  await writeConfig(config);
  return { listing, apiBaseUrl, detectedGpu };
}

export async function listGpuCapacity({ mine = false, apiUrl } = {}) {
  const path = mine ? '/v1/capacity/gpu/mine' : '/v1/capacity/gpu';
  const { payload, apiBaseUrl } = await capacityRequest(path, { auth: mine, apiUrl });
  return { listings: Array.isArray(payload.data) ? payload.data : [], apiBaseUrl };
}

export async function changeGpuCapacityStatus(id, action, flags = {}) {
  if (!id) {
    const config = await readConfig();
    id = config.capacity?.lastListingId;
  }
  if (!id) {
    throw new Error(`Usage: om capacity ${action} <listing-id>`);
  }
  const { payload, apiBaseUrl } = await capacityRequest(`/v1/capacity/gpu/${encodeURIComponent(id)}/${action}`, {
    method: 'POST',
    body: action === 'heartbeat' ? {
      availableGpuCount: flags['available-gpus'] === undefined ? undefined : requireInteger(flags['available-gpus'], '--available-gpus'),
      runtimeStatus: stringFlag(flags, 'runtime-status') || undefined
    } : {},
    apiUrl: flags['api-url']
  });
  return { listing: payload.data, apiBaseUrl };
}

export function formatGpuCapacityTable(listings) {
  if (listings.length === 0) {
    return 'No GPU capacity listings found.';
  }
  const header = ['ID', 'STATUS', 'GPU', 'AVAILABLE', 'VRAM', 'PRICE', 'CONNECTION'].join('\t');
  const rows = listings.map((listing) => [
    listing.id,
    listing.status,
    listing.gpuModel,
    `${listing.availableGpuCount}/${listing.gpuCount}`,
    `${listing.vramGbPerGpu} GB`,
    `${listing.currency} ${Number(listing.pricePerGpuHour).toFixed(2)}/GPU-h`,
    listing.connectionMode
  ].join('\t'));
  return [header, ...rows].join('\n');
}

export function capacityHelpText() {
  return `om capacity <command> [options]\n\nCommands:\n  expose --price-hour 0.75 [--endpoint https://gpu.example.com]\n  list\n  mine\n  publish [listing-id]\n  pause [listing-id]\n  heartbeat [listing-id] [--available-gpus 1]\n  detect\n\nExpose options:\n  --gpu-model "NVIDIA RTX 4090"\n  --gpus 1\n  --vram-gb 24\n  --price-hour 0.75\n  --endpoint https://gpu.example.com\n  --connection OPENMODEL_API|HTTPS_API|SSH|WIREGUARD|TAILSCALE|MANUAL\n  --allocation EXCLUSIVE|MIG|TIME_SLICED\n  --location "Northern Virginia"\n  --minimum-hours 1\n  --max-hours 24\n  --draft\n  --dry-run\n  --api-url https://api.openmodel.sh\n`;
}
