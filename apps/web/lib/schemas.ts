/**
 * schemas.ts — Contrato Zod do NOC (FASE 4, B-04: validação de respostas).
 *
 * Fonte: Fase1-Arquitetura-KPIs-2026-07-02.md (catálogo de KPIs).
 * Endpoints marcados [FASE 3] ainda não existem no backend — o lib/noc.ts
 * cai para mock rotulado quando recebem 404. Quando a FASE 3 implementar os
 * coletores, estes schemas são o contrato que o backend deve honrar
 * (espelhar em packages/shared na FASE 3).
 *
 * Convenção: schemas lenientes (.passthrough(), campos novos opcionais) —
 * backend pode evoluir sem quebrar o frontend.
 */
import { z } from "zod";

// ─── RAG (semântica de cor fixa da Fase 1) ─────────────────────────────
export type Rag = "ok" | "warn" | "crit" | "stale";
export const RagSchema = z.enum(["ok", "warn", "crit", "stale"]);

/** Limiar W/C → RAG. `invert` para métricas onde menor = pior (ex.: dias p/ expirar). */
export function ragOf(
  value: number | null | undefined,
  warn: number,
  crit: number,
  invert = false
): Rag {
  if (value == null || Number.isNaN(value)) return "stale";
  if (invert) return value <= crit ? "crit" : value <= warn ? "warn" : "ok";
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

/** Catálogo de limiares (Fase 1 §A) — usado em bandas de gráfico e semáforos. */
export const THRESHOLDS = {
  cpuPercent: { warn: 80, crit: 95 },
  cpuSteal: { warn: 10, crit: 25 },
  loadPerCore: { warn: 1.0, crit: 2.0 },
  psiCpuSomeAvg60: { warn: 25, crit: 75 },
  memPercent: { warn: 85, crit: 95 },
  psiMemFullAvg60: { warn: 2, crit: 5 },
  diskPercent: { warn: 80, crit: 90 },
  diskAwaitMs: { warn: 20, crit: 100 },
  diskUtilPercent: { warn: 80, crit: 95 },
  psiIoFullAvg10: { warn: 15, crit: 25 },
  containerCpu: { warn: 80, crit: 95 },
  containerMem: { warn: 85, crit: 95 },
  restarts24h: { warn: 3, crit: 10 },
  sslDays: { warn: 30, crit: 7 }, // invert
  deploySuccessPct: { warn: 90, crit: 75 } // invert
} as const;

// ─── Host básico (endpoint existente /srv1/host) ───────────────────────
export const HostMetricsSchema = z
  .object({
    cpuPercent: z.number(),
    loadAvg: z.array(z.number()).min(3),
    memTotalMb: z.number(),
    memUsedMb: z.number(),
    memPercent: z.number(),
    diskTotalGb: z.number(),
    diskUsedGb: z.number(),
    diskPercent: z.number(),
    swapUsedMb: z.number().nullable().optional(),
    uptimeSeconds: z.number().nullable().optional(),
    netInBytes: z.coerce.number().nullable().optional(),
    netOutBytes: z.coerce.number().nullable().optional(),
    nproc: z.number().nullable().optional(),
    cpuStealPercent: z.number().nullable().optional()
  })
  .passthrough();
export type HostMetrics = z.infer<typeof HostMetricsSchema>;

// ─── Saturação PSI [FASE 3: GET /srv1/saturation] ──────────────────────
export const PsiLineSchema = z
  .object({
    avg10: z.number(),
    avg60: z.number(),
    avg300: z.number().nullable().optional()
  })
  .passthrough();

export const PsiResourceSchema = z
  .object({
    some: PsiLineSchema,
    full: PsiLineSchema.nullable().optional()
  })
  .passthrough();

export const HostSaturationSchema = z
  .object({
    ts: z.string().nullable().optional(),
    psi: z
      .object({
        cpu: PsiResourceSchema,
        io: PsiResourceSchema,
        memory: PsiResourceSchema
      })
      .passthrough(),
    swap: z
      .object({
        totalMb: z.number(),
        usedMb: z.number(),
        inPagesSec: z.number().nullable().optional(),
        outPagesSec: z.number().nullable().optional()
      })
      .passthrough()
      .nullable()
      .optional(),
    nproc: z.number().nullable().optional(),
    loadPerCore: z.number().nullable().optional()
  })
  .passthrough();
export type HostSaturation = z.infer<typeof HostSaturationSchema>;

// ─── IO de disco [FASE 3: GET /srv1/diskio] ────────────────────────────
export const DiskIoDeviceSchema = z
  .object({
    device: z.string(),
    utilPercent: z.number(),
    readAwaitMs: z.number().nullable().optional(),
    writeAwaitMs: z.number().nullable().optional(),
    readIops: z.number().nullable().optional(),
    writeIops: z.number().nullable().optional(),
    readKbps: z.number().nullable().optional(),
    writeKbps: z.number().nullable().optional(),
    avgQueueSize: z.number().nullable().optional()
  })
  .passthrough();

export const HostDiskIoSchema = z
  .object({
    ts: z.string().nullable().optional(),
    devices: z.array(DiskIoDeviceSchema)
  })
  .passthrough();
export type HostDiskIo = z.infer<typeof HostDiskIoSchema>;

// ─── Rede [FASE 3: GET /srv1/network] ──────────────────────────────────
export const NetIfaceSchema = z
  .object({
    iface: z.string(),
    rxKbps: z.number(),
    txKbps: z.number(),
    rxErrors: z.number().nullable().optional(),
    txErrors: z.number().nullable().optional(),
    rxDrops: z.number().nullable().optional(),
    txDrops: z.number().nullable().optional()
  })
  .passthrough();

export const HostNetworkSchema = z
  .object({
    ts: z.string().nullable().optional(),
    ifaces: z.array(NetIfaceSchema),
    tcpRetransPercent: z.number().nullable().optional()
  })
  .passthrough();
export type HostNetwork = z.infer<typeof HostNetworkSchema>;

// ─── Containers (endpoint existente /srv1/containers) ─────────────────
export const ContainerSummarySchema = z
  .object({
    name: z.string(),
    image: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    cpuPercent: z.number().nullable().optional(),
    memMb: z.number().nullable().optional(),
    memPercent: z.number().nullable().optional(),
    uptime: z.string().nullable().optional(),
    healthcheck: z.string().nullable().optional(),
    restartCount: z.number().nullable().optional(),
    netRxKbps: z.number().nullable().optional(),
    netTxKbps: z.number().nullable().optional()
  })
  .passthrough();
export type ContainerRow = z.infer<typeof ContainerSummarySchema>;
export const ContainerListSchema = z.array(ContainerSummarySchema);

// ─── Série temporal por container ───────────────────────────────────────
// Real hoje: GET /analytics/containers/:name/history (snapshots existentes).
export const ContainerPointSchema = z
  .object({
    ts: z.string().or(z.number()).nullable().optional(),
    createdAt: z.string().nullable().optional(),
    cpuPercent: z.number().nullable().optional(),
    memMb: z.number().nullable().optional(),
    memUsedMb: z.number().nullable().optional(),
    memPercent: z.number().nullable().optional(),
    netRxKbps: z.number().nullable().optional(),
    netTxKbps: z.number().nullable().optional(),
    blkioReadKbps: z.number().nullable().optional(),
    blkioWriteKbps: z.number().nullable().optional(),
    restartCount: z.number().nullable().optional(),
    health: z.string().nullable().optional()
  })
  .passthrough();
export type ContainerPoint = z.infer<typeof ContainerPointSchema>;
export const ContainerSeriesSchema = z.array(ContainerPointSchema);

// ─── Eventos de estado [FASE 3: GET /srv1/containers/:name/events] ─────
export const StateEventSchema = z
  .object({
    ts: z.string(),
    fromState: z.string().nullable().optional(),
    toState: z.string(),
    exitCode: z.number().nullable().optional(),
    oomKilled: z.boolean().nullable().optional(),
    reason: z.string().nullable().optional()
  })
  .passthrough();
export type StateEvent = z.infer<typeof StateEventSchema>;
export const StateEventListSchema = z.array(StateEventSchema);

// ─── Coolify (endpoints existentes) ────────────────────────────────────
export const CoolifyAppSchema = z
  .object({
    uuid: z.string(),
    name: z.string(),
    status: z.string().nullable().optional(),
    fqdn: z.string().nullable().optional(),
    git_branch: z.string().nullable().optional(),
    git_commit_sha: z.string().nullable().optional()
  })
  .passthrough();
export const CoolifyAppListSchema = z.array(CoolifyAppSchema);
export type CoolifyAppRow = z.infer<typeof CoolifyAppSchema>;

export const CoolifyDeploymentSchema = z
  .object({
    id: z.union([z.string(), z.number()]).nullable().optional(),
    deployment_uuid: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    commit: z.string().nullable().optional(),
    commit_message: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    started_at: z.string().nullable().optional(),
    finished_at: z.string().nullable().optional(),
    durationSec: z.number().nullable().optional()
  })
  .passthrough();
export const CoolifyDeploymentListSchema = z.array(CoolifyDeploymentSchema);
export type CoolifyDeploymentRow = z.infer<typeof CoolifyDeploymentSchema>;

// ─── Confiabilidade [FASE 3: GET /analytics/reliability] ───────────────
export const ReliabilityTargetSchema = z
  .object({
    targetType: z.string(),
    targetKey: z.string(),
    uptimePct: z.number().nullable().optional(),
    incidents: z.number().nullable().optional(),
    downtimeSec: z.number().nullable().optional()
  })
  .passthrough();

export const ReliabilitySchema = z
  .object({
    windowDays: z.number().nullable().optional(),
    availabilityPct: z.number().nullable().optional(),
    coveragePct: z.number().nullable().optional(),
    mttrMinutes: z.number().nullable().optional(),
    timeToDetectMinutes: z.number().nullable().optional(),
    mtbfHours: z.number().nullable().optional(),
    incidentCount: z.number().nullable().optional(),
    deploySuccessRatePct: z.number().nullable().optional(),
    deploysTotal: z.number().nullable().optional(),
    byTarget: z.array(ReliabilityTargetSchema).nullable().optional(),
    dailyAvailability: z
      .array(
        z
          .object({
            date: z.string(),
            uptimePct: z.number().nullable().optional(),
            incidents: z.number().nullable().optional()
          })
          .passthrough()
      )
      .nullable()
      .optional()
  })
  .passthrough();
export type Reliability = z.infer<typeof ReliabilitySchema>;

// ─── Golden signals / health macro [FASE 3: GET /analytics/health] ─────
export const SignalSchema = z
  .object({
    value: z.number().nullable().optional(),
    unit: z.string().nullable().optional(),
    rag: RagSchema.nullable().optional(),
    label: z.string().nullable().optional(),
    spark: z.array(z.number()).nullable().optional()
  })
  .passthrough();

export const HealthOverviewSchema = z
  .object({
    score: z.number().nullable().optional(),
    rag: RagSchema.nullable().optional(),
    signals: z
      .object({
        latency: SignalSchema.nullable().optional(),
        traffic: SignalSchema.nullable().optional(),
        errors: SignalSchema.nullable().optional(),
        saturation: SignalSchema.nullable().optional()
      })
      .passthrough()
      .nullable()
      .optional(),
    mostImportant: z
      .object({
        title: z.string(),
        detail: z.string().nullable().optional(),
        href: z.string().nullable().optional(),
        severity: z.string().nullable().optional()
      })
      .passthrough()
      .nullable()
      .optional()
  })
  .passthrough();
export type HealthOverview = z.infer<typeof HealthOverviewSchema>;

// ─── Histórico de host (endpoint existente /analytics/host/history) ────
export const HostHistoryPointSchema = z
  .object({
    createdAt: z.string(),
    cpuPercent: z.number().nullable().optional(),
    memUsedMb: z.number().nullable().optional(),
    memTotalMb: z.number().nullable().optional(),
    diskPercent: z.number().nullable().optional(),
    loadAvg1m: z.number().nullable().optional()
  })
  .passthrough();
export const HostHistorySchema = z.array(HostHistoryPointSchema);
export type HostHistoryPoint = z.infer<typeof HostHistoryPointSchema>;
