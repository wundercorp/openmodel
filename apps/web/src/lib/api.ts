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


export interface LocalRuntimeRecord {
  id: string;
  available: boolean;
  binary?: string;
  installCommand?: string;
}

export interface LocalRuntimeModelStatus {
  id: string;
  format?: string;
  requiredRuntimeIds: string[];
  availableRuntimeId?: string;
  runnable: boolean;
}

export interface LocalRuntimeStatus {
  platform: string;
  architecture: string;
  runtimes: LocalRuntimeRecord[];
  models: LocalRuntimeModelStatus[];
}

export interface LocalChatCompletion {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    estimated?: boolean;
  };
  openmodel_metrics?: {
    latency_ms: number;
    completion_tokens_per_second: number;
  };
}


export type LocalInferenceRequestStatus = "success" | "error" | "cancelled";

export interface LocalInferenceRecentRequest {
  id: string;
  endpoint: string;
  modelId: string;
  runtimeId?: string;
  status: LocalInferenceRequestStatus;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  tokensPerSecond: number;
  error?: string;
  startedAt: string;
  completedAt: string;
}

export interface LocalModelMetricRecord {
  modelId: string;
  runtimeId?: string;
  requests: number;
  successfulRequests: number;
  failedRequests: number;
  cancelledRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageLatencyMs: number;
  maxLatencyMs: number;
  averageTokensPerSecond: number;
  lastUsedAt?: string;
}

export interface LocalMetricsSnapshot {
  generatedAt: string;
  scope: "local";
  privacy: {
    localOnly: boolean;
    promptContentStored: boolean;
    responseContentStored: boolean;
    persistence: string;
    tokenCounting: string;
  };
  server: {
    startedAt: string;
    uptimeSeconds: number;
    metricsStartedAt: string;
    metricsUptimeSeconds: number;
    host?: string;
    port?: number;
  };
  inference: {
    activeRequests: number;
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    cancelledRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    averageLatencyMs: number;
    p50LatencyMs: number;
    p95LatencyMs: number;
    maxLatencyMs: number;
    averageTokensPerSecond: number;
    errorRate: number;
    lastRequestAt?: string;
    lastSuccessAt?: string;
    lastFailureAt?: string;
  };
  models: {
    installedCount: number;
    runnableCount: number;
    storageBytes: number;
    byModel: LocalModelMetricRecord[];
  };
  installs: {
    active: number;
    completed: number;
    failed: number;
    downloadedBytes: number;
  };
  recentRequests: LocalInferenceRecentRequest[];
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

export async function getLocalRuntimeStatus(
  localApiUrl: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(`${normalizedLocalApiUrl}/v1/runtime-status`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = await readJsonResponse<{ data: LocalRuntimeStatus }>(response);
  return payload.data;
}


export async function getLocalMetrics(
  localApiUrl: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(`${normalizedLocalApiUrl}/v1/metrics`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  const payload = await readJsonResponse<{ data: LocalMetricsSnapshot }>(response);
  return payload.data;
}

export async function resetLocalMetrics(
  localApiUrl: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(`${normalizedLocalApiUrl}/v1/metrics/reset`, {
    method: "POST",
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
  });
  return readJsonResponse<{ data: { reset: boolean; resetAt: string } }>(response);
}

export async function createLocalChatCompletion(
  localApiUrl: string,
  model: string,
  prompt: string,
  signal?: AbortSignal,
) {
  const normalizedLocalApiUrl = normalizeLocalApiUrl(localApiUrl);
  const response = await fetch(
    `${normalizedLocalApiUrl}/v1/chat/completions`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 96,
      }),
      cache: "no-store",
      signal,
    },
  );
  return readJsonResponse<LocalChatCompletion>(response);
}
