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

// Sinc: projection only; never an execution or acceptance authority.
export interface SincProjectionEvent {
  event_version: "route-projection-event-v1";
  event_id: string;
  idempotency_key: string;
  project_id: string;
  entity_id: string;
  revision: number;
  occurred_at: string;
  source: { kind: "observer_f3" | "pilot_f4" | "projection_fixture"; reference_id: string; data_class: "observed" | "simulated" };
  state: "recommendation" | "blocked" | "integration_failure";
  route: { route_id: string; model_id: string; effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra" } | null;
  policy: { policy_id: string; decision_hash: string };
  metrics: { duration_ms: number | null; api_equivalent_cost_micros: number | null; observed_billed_cost_micros: number | null; currency: "USD" };
}
export interface SincCostAggregate {
  currency: "USD";
  knownCount: number;
  unknownCount: number;
  knownSumMicros: string;
  totalMicros: string | null;
}
export interface SincDashboard {
  integration: SincIntegrationSnapshot;
  generatedAt: string;
  source: "postgres_projection";
  authority: "informational_only";
  state: "empty" | "available";
  projectId: string | null;
  projects: string[];
  overview: {
    totalEvents: number;
    recommendations: number;
    blocked: number;
    integrationFailures: number;
    observedEvents: number;
    simulatedEvents: number;
    apiEquivalentCost: SincCostAggregate;
    observedBilledCost: SincCostAggregate;
    durationMs: { p50: number | null; p95: number | null };
  };
  recentRoutes: SincProjectionEvent[];
  modelTree: Array<{ modelId: string; effort: string; state: SincProjectionEvent["state"]; count: number }>;
  health: {
    sampleLimit: number;
    sampleLimited: boolean;
    totalStoredEvents: number;
    latestOccurredAt: string | null;
    latestReceivedAt: string | null;
    lagSeconds: number | null;
    gapStatus: "not_measured";
  };
}

export interface SincIntegrationSnapshot {
  evidenceKind: "last_measured";
  measuredAt: "2026-09-14T20:18:00-04:00";
  clients: Array<{ client: "Codex" | "Claude Code" | "Cowork"; status: "workflow_validated" | "connector_configured"; mcpConfig: "present" }>;
  versions: Array<{ resource: "sinc-mcp" | "mac-dark" | "mac-light"; version: string; status: "declared" | "parity_matched"; clients: string[] }>;
  projects: Array<{ projectId: string; policy: "configured"; map: "linked"; obsidian: "linked" }>;
  contract: { contractId: "5feee1ff-bfc1-4f42-9709-b08a786d9779"; requirementCount: 5; status: "prepared" };
}

export interface SincProjectionBatch {
  schema_version: "route-events-batch-v1";
  batch_id: string;
  idempotency_key: string;
  project_id: string;
  generated_at: string;
  events: SincProjectionEvent[];
  batch_hash: string;
}
