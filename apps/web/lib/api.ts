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

// A-02: access token vive SOMENTE em memória (não em localStorage — fora do alcance de XSS).
// Em reload ele é perdido e re-obtido via /auth/refresh (refresh está no cookie httpOnly).
let accessToken: string | null = null;
export function setAccessToken(t: string | null) { accessToken = t; }
export function getAccessToken(): string | null { return accessToken; }

function getToken(): string | null {
  return accessToken;
}

/**
 * UX-18: mapeia erros técnicos para mensagens amigáveis (sem vazar IPs/URLs internas).
 * O erro técnico completo fica só no console.
 */
function friendlyMessage(status: number, body: any): string {
  const raw = typeof body?.message === "string" ? body.message : "";
  // Mensagens do nosso backend já em PT-BR e sem detalhes internos passam direto
  if (raw && !/\d+\.\d+\.\d+\.\d+|ECONN|ETIMEDOUT|EHOSTUNREACH|localhost|:\d{4,5}/i.test(raw)) return raw;
  switch (status) {
    case 0: return "Sem conexão com o servidor. Verifique sua rede e tente novamente.";
    case 401: return "Sessão expirada. Faça login novamente.";
    case 403: return "Ação não permitida ou código OTP inválido.";
    case 404: return "Recurso não encontrado.";
    case 429: return "Muitas tentativas. Aguarde um momento e tente novamente.";
    default:
      if (status >= 500) return "Erro no servidor. Tente novamente em instantes.";
      return "Não foi possível concluir a operação. Tente novamente.";
  }
}

// FE-03: refresh single-flight — várias requests 401 simultâneas disparam UM refresh só.
let refreshing: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      // A-02: refresh vem do cookie httpOnly — sem body, apenas credentials.
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: "{}"
      });
      if (!res.ok) return false;
      const body = await res.json();
      if (!body?.accessToken) return false;
      setAccessToken(body.accessToken);
      return true;
    } catch {
      return false;
    } finally {
      // libera o single-flight no próximo tick
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

function redirectToLogin() {
  try {
    setAccessToken(null);
    localStorage.removeItem("controler:user");
  } catch { /* ignore */ }
  if (typeof window !== "undefined" && !location.pathname.startsWith("/login")) {
    location.href = "/login";
  }
}

export async function apiFetch<T = any>(
  path: string,
  init: RequestInit & { otp?: string; _retried?: boolean } = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>)
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (init.otp) headers["X-Otp-Code"] = init.otp;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: "include" });
  } catch (err) {
    console.error(`[api] network error ${path}:`, err);
    throw new ApiError(0, friendlyMessage(0, null));
  }
  const text = await res.text();
  const body = text ? safeParse(text) : null;

  // FE-03: 401 em rota protegida → tenta refresh 1x e repete a request
  const isAuthPath = path.startsWith("/auth/");
  if (res.status === 401 && !isAuthPath && !init._retried) {
    const ok = await tryRefresh();
    if (ok) return apiFetch<T>(path, { ...init, _retried: true });
    redirectToLogin();
  }

  if (!res.ok) {
    console.error(`[api] ${res.status} ${path}:`, body);
    throw new ApiError(res.status, friendlyMessage(res.status, body), body);
  }
  return body as T;
}

function safeParse(t: string) { try { return JSON.parse(t); } catch { return t; } }

export const api = {
  // Auth
  requestCode: (phone: string, channel: "auto" | "whatsapp" | "sms" = "auto") =>
    apiFetch<{ success: boolean; firstName?: string; channel?: string }>(
      "/auth/request-code",
      { method: "POST", body: JSON.stringify({ phone, channel }) }
    ),
  requestCodeSms: (phone: string) =>
    apiFetch<{ success: boolean; firstName?: string; channel?: string }>(
      "/auth/request-code-sms",
      { method: "POST", body: JSON.stringify({ phone }) }
    ),
  verifyCode: (phone: string, code: string) => apiFetch<{ accessToken: string; user: any; expiresAt: string }>("/auth/verify-code", { method: "POST", body: JSON.stringify({ phone, code }) }),
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
  coolifyDeployments: (uuid: string) => apiFetch(`/coolify/apps/${uuid}/deployments`),
  coolifyServers: () => apiFetch("/coolify/servers"),
  coolifyRestart: (uuid: string, otp: string) => apiFetch(`/coolify/apps/${uuid}/restart`, { method: "POST", otp }),
  coolifyStop: (uuid: string, otp: string) => apiFetch(`/coolify/apps/${uuid}/stop`, { method: "POST", otp }),
  coolifyStart: (uuid: string, otp: string) => apiFetch(`/coolify/apps/${uuid}/start`, { method: "POST", otp }),

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
  hostUptime: (hours = 24) => apiFetch<{ uptimePercent: number; samples: number }>(`/analytics/host/uptime?hours=${hours}`),
  topContainers: (by: "cpu" | "mem" = "cpu", hours = 24, limit = 10) =>
    apiFetch<Array<{ name: string; avgCpu: number; avgMem: number; samples: number }>>(
      `/analytics/containers/top?by=${by}&hours=${hours}&limit=${limit}`
    ),
  alertsBreakdown: (hours = 24) => apiFetch(`/analytics/alerts/breakdown?hours=${hours}`),

  // Users
  users: () => apiFetch("/users")
};
