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
    error?: string;
  };
  if (!response.ok) {
    throw new Error(
      payload.error ?? `OpenModel API returned HTTP ${response.status}.`,
    );
  }
  return payload;
}

export function getApiBaseUrl() {
  return apiBaseUrl;
}

export async function getDashboardUser() {
  const response = await authenticatedFetch(`${apiBaseUrl}/v1/me`);
  return readJsonResponse<DashboardUser>(response);
}

export async function getGatewayRegistry() {
  const response = await fetch(`${apiBaseUrl}/v1/gateways`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  const payload = await readJsonResponse<{ data: GatewayRecord[] }>(response);
  return payload.data;
}
