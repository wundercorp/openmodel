import { authenticatedFetch } from "./auth";

export interface DashboardUser {
  id: string;
  email?: string;
  name?: string;
  username?: string;
  scope?: string;
  permissions: string[];
  groups: string[];
  clientId?: string;
}

export interface LocalModelRecord {
  id: string;
  object?: string;
  owned_by?: string;
}

export interface InstallableLocalModel {
  id: string;
  name: string;
  description: string;
  reference: string;
  alias: string;
  format: string;
  parameterCount: string;
  sizeBytes: number;
  license: string;
  sourceUrl: string;
  installed: boolean;
  installedModelId?: string;
}

export type ModelInstallStatus =
  | "queued"
  | "resolving"
  | "downloading"
  | "installing"
  | "completed"
  | "error";

export interface ModelInstallJob {
  id: string;
  catalogId: string;
  status: ModelInstallStatus;
  progress: number;
  stage: string;
  message: string;
  fileName?: string;
  downloadedBytes?: number;
  totalBytes?: number;
  modelId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface GatewayRecord {
  id: string;
  name: string;
  schemes?: string[];
  capabilities?: string[];
  packageName?: string;
  repository?: string;
  apiVersion?: number;
  submittedAt?: string;
}

const apiBaseUrl = String(
  import.meta.env.VITE_API_URL ??
    import.meta.env.VITE_CLOUD_API_URL ??
    "https://api.openmodel.sh",
)
  .trim()
  .replace(/\/$/, "");

async function readJsonResponse<T>(response: Response) {
  const payload = (await response.json().catch(() => ({}))) as T & {
    error?: string | { message?: string };
  };
  if (!response.ok) {
    const errorMessage =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message;
    throw new Error(
      errorMessage ?? `OpenModel API returned HTTP ${response.status}.`,
    );
  }
  return payload;
}

function normalizeLocalApiUrl(localApiUrl: string) {
  return localApiUrl.trim().replace(/\/$/, "");
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export async function getDashboardUser(signal?: AbortSignal) {
  const response = await authenticatedFetch(`${apiBaseUrl}/v1/me`, { signal });
  return readJsonResponse<DashboardUser>(response);
}

export async function getGatewayRegistry(signal?: AbortSignal) {
  const response = await fetch(`${apiBaseUrl}/v1/gateways`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = await readJsonResponse<{ data: GatewayRecord[] }>(response);
  return payload.data;
}

export async function getLocalModels(
  localApiUrl: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(`${normalizedLocalApiUrl}/v1/models`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = await readJsonResponse<{ data: LocalModelRecord[] }>(
    response,
  );
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function getLocalModelCatalog(
  localApiUrl: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(`${normalizedLocalApiUrl}/v1/model-catalog`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = await readJsonResponse<{ data: InstallableLocalModel[] }>(
    response,
  );
  return Array.isArray(payload.data) ? payload.data : [];
}

export async function startLocalModelInstall(
  localApiUrl: string,
  catalogId: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(`${normalizedLocalApiUrl}/v1/models/install`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ catalogId }),
    cache: "no-store",
    signal,
  });
  const payload = await readJsonResponse<{ data: ModelInstallJob }>(response);
  return payload.data;
}

export async function getLocalModelInstall(
  localApiUrl: string,
  jobId: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(
    `${normalizedLocalApiUrl}/v1/model-installs/${encodeURIComponent(jobId)}`,
    {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    },
  );
  const payload = await readJsonResponse<{ data: ModelInstallJob }>(response);
  return payload.data;
}
