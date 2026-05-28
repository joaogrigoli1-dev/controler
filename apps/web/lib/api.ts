/**
 * api.ts — cliente HTTP simples para o backend NestJS.
 * Em prod o frontend Next.js está atrás do mesmo Traefik que o api,
 * mas comunica via rewrite Next (`/api/v1/...` → backend).
 */

const BASE = "/be";

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: any) {
    super(message);
  }
}

function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("controler:token");
}

export async function apiFetch<T = any>(
  path: string,
  init: RequestInit & { otp?: string } = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>)
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (init.otp) headers["X-Otp-Code"] = init.otp;

  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: "include" });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) throw new ApiError(res.status, body?.message || `HTTP ${res.status}`, body);
  return body as T;
}

function safeParse(t: string) { try { return JSON.parse(t); } catch { return t; } }

export const api = {
  // Auth
  requestCode: (phone: string) => apiFetch("/auth/request-code", { method: "POST", body: JSON.stringify({ phone }) }),
  verifyCode: (phone: string, code: string) => apiFetch<{ accessToken: string; refreshToken: string; user: any; expiresAt: string }>("/auth/verify-code", { method: "POST", body: JSON.stringify({ phone, code }) }),
  reauthRequest: () => apiFetch("/auth/reauth/request", { method: "POST" }),
  logout: () => apiFetch("/auth/logout", { method: "POST" }),
  me: () => apiFetch("/auth/me"),

  // SRV1
  hostMetrics: () => apiFetch("/srv1/host"),
  containers: () => apiFetch("/srv1/containers"),
  services: () => apiFetch("/srv1/services"),
  processes: (by: "cpu" | "mem" = "cpu") => apiFetch(`/srv1/processes?by=${by}`),
  ports: () => apiFetch("/srv1/ports"),
  journal: (unit: string, lines = 100) => apiFetch(`/srv1/journal/${unit}?lines=${lines}`),
  restartService: (unit: string, otp: string) => apiFetch(`/srv1/services/${unit}/restart`, { method: "POST", otp }),
  containerAction: (name: string, action: string, otp: string) => apiFetch(`/srv1/containers/${name}/${action}`, { method: "POST", otp }),

  // Coolify
  coolifyApps: () => apiFetch("/coolify/apps"),
  coolifyApp: (uuid: string) => apiFetch(`/coolify/apps/${uuid}`),
  coolifyEnvs: (uuid: string) => apiFetch(`/coolify/apps/${uuid}/envs`),
  coolifyLogs: (uuid: string, lines = 200) => apiFetch(`/coolify/apps/${uuid}/logs?lines=${lines}`),
  coolifyDeploy: (uuid: string, otp: string) => apiFetch(`/coolify/apps/${uuid}/deploy?force=true`, { method: "POST", otp }),

  // Hestia / Mail & Sites
  sites: () => apiFetch("/hestia/sites"),
  mail: () => apiFetch("/hestia/mail"),

  // Vault
  vaultList: (project?: string) => apiFetch(`/vault/params${project ? `?project=${project}` : ""}`),
  vaultReveal: (name: string, otp: string) => apiFetch("/vault/reveal", { method: "POST", body: JSON.stringify({ name }), otp }),
  vaultAudit: () => apiFetch("/vault/audit"),

  // Alerts
  alerts: () => apiFetch("/alerts"),
  alertsSummary: () => apiFetch("/alerts/summary"),
  alertsRules: () => apiFetch("/alerts/rules"),
  alertsTest: (body: any) => apiFetch("/alerts/test", { method: "POST", body: JSON.stringify(body) }),

  // Timeline
  timeline: (severity?: string, limit = 50) => apiFetch(`/timeline${severity ? `?severity=${severity}&limit=${limit}` : `?limit=${limit}`}`),
  heatmap: () => apiFetch("/timeline/heatmap"),

  // Deploys
  deploys: (project?: string) => apiFetch(`/deploys${project ? `?project=${project}` : ""}`),
  deployStats: () => apiFetch("/deploys/stats"),

  // APIs
  apis: (project?: string) => apiFetch(`/apis${project ? `?project=${project}` : ""}`),
  apisPing: () => apiFetch("/apis/ping", { method: "POST" }),

  // Scanner
  scannerRun: () => apiFetch("/scanner/run", { method: "POST" }),
  scannerFindings: () => apiFetch("/scanner/findings"),
  scannerFix: (id: string, otp: string) => apiFetch(`/scanner/findings/${id}/fix`, { method: "POST", otp }),

  // Analytics
  analyticsOverview: (days = 7) => apiFetch(`/analytics/overview?days=${days}`),
  hostHistory: (hours = 24) => apiFetch(`/analytics/host/history?hours=${hours}`),

  // Users
  users: () => apiFetch("/users")
};
