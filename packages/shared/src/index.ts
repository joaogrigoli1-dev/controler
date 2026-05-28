import { z } from "zod";

// ─── Auth ─────────────────────────────────────────────────
export const RequestCodeSchema = z.object({
  phone: z.string().min(10).max(15)
});
export type RequestCodeDto = z.infer<typeof RequestCodeSchema>;

export const VerifyCodeSchema = z.object({
  phone: z.string().min(10).max(15),
  code: z.string().length(6)
});
export type VerifyCodeDto = z.infer<typeof VerifyCodeSchema>;

export const RevealVaultSchema = z.object({
  name: z.string().min(1),
  otpCode: z.string().length(6)
});
export type RevealVaultDto = z.infer<typeof RevealVaultSchema>;

// ─── Realtime channels ────────────────────────────────────
export const RT_CHANNELS = {
  HOST_METRICS: "host:metrics",
  CONTAINER_METRICS: "container:metrics",
  TIMELINE: "timeline",
  ALERT_FIRED: "alert:fired",
  DEPLOY_UPDATE: "deploy:update"
} as const;

// ─── Severities ───────────────────────────────────────────
export type Severity = "info" | "warning" | "critical";
export const SEVERITY_ORDER: Record<Severity, number> = { info: 0, warning: 1, critical: 2 };

// ─── KPI types ────────────────────────────────────────────
export interface HostMetrics {
  cpuPercent: number;
  loadAvg: [number, number, number];
  memTotalMb: number;
  memUsedMb: number;
  memPercent: number;
  diskTotalGb: number;
  diskUsedGb: number;
  diskPercent: number;
  swapUsedMb: number;
  uptimeSeconds: number;
  netInBytes: number;
  netOutBytes: number;
}

export interface ContainerSummary {
  name: string;
  image: string;
  status: string;
  state: string;
  cpuPercent: number;
  memMb: number;
  memPercent: number;
  uptime: string;
  healthcheck?: "healthy" | "unhealthy" | "starting" | "none";
  ports?: string[];
}

export interface CoolifyApp {
  uuid: string;
  name: string;
  status: string;
  fqdn: string;
  gitBranch?: string;
  gitCommitSha?: string;
  lastSeen?: string;
}

export interface VaultParam {
  name: string;
  type: string;
  lastModified: string;
  group: string;
  hasValue: boolean;
  value?: string; // only when revealed
}

export interface AlertSummary {
  total: number;
  critical: number;
  warning: number;
  info: number;
  silenced: number;
  last24h: number;
}
