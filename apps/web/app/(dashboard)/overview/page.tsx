"use client";
/**
 * /overview — visão macro do NOC (FASE 4).
 * Golden Signals (/analytics/health, mock rotulado até a FASE 3) + KPIs reais,
 * heatmap de containers com drill-down, timeline, infra e deploys recentes.
 */
import useSWR from "swr";
import Link from "next/link";
import { api } from "@/lib/api";
import { nocFetch, useNoc } from "@/lib/noc";
import { ContainerListSchema, HealthOverviewSchema, ragOf, type Rag } from "@/lib/schemas";
import { mockHealthOverview } from "@/lib/mocks";
import { useSocketEvent } from "@/lib/socket";
import { KpiTile } from "@/components/ui/KpiTile";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Gauge } from "@/components/ui/Gauge";
import { RagBadge } from "@/components/noc/RagBadge";
import { DataBadge } from "@/components/noc/DataBadge";
import { Sparkline } from "@/components/noc/Sparkline";
import { ContainerHeatmap } from "@/components/noc/ContainerHeatmap";
import { EventTimeline, type TimelineItem } from "@/components/noc/EventTimeline";
import { CardError } from "@/components/noc/CardError";
import { Skeleton } from "@/components/noc/Skeleton";
import { cn, fmtBytes, fmtUptime } from "@/lib/utils";
import {
  AlertTriangle, ArrowRight, Boxes, CheckCircle2, Clock, Cpu, Globe, HardDrive,
  HeartPulse, MemoryStick, Rocket, Server, ShieldAlert, XCircle, Zap
} from "lucide-react";

// Containers críticos de infra que devem aparecer no painel "Status de infra".
// Cada entry tem regex/substring matcher + label público + classificação.
const INFRA_TARGETS: Array<{ key: string; label: string; match: (name: string) => boolean }> = [
  { key: "postgres", label: "Postgres main", match: n => /^postgres-main|^postgresql-|postgres$/.test(n) },
  { key: "redis", label: "Redis", match: n => /redis/.test(n) },
  { key: "traefik", label: "Traefik proxy", match: n => /traefik|coolify-proxy/.test(n) },
  { key: "mail", label: "Mail (Stalwart)", match: n => /^mailserver|stalwart/.test(n) }
];

const SIGNAL_ORDER = [
  { key: "latency", fallbackLabel: "Latência" },
  { key: "traffic", fallbackLabel: "Tráfego" },
  { key: "errors", fallbackLabel: "Erros" },
  { key: "saturation", fallbackLabel: "Saturação" }
] as const;

export default function OverviewPage() {
  // ── Dados reais existentes (padrão atual: api.* + useSWR) ──────────────
  const { data: host } = useSWR("host", () => api.hostMetrics(), { refreshInterval: 30000 });
  const { data: apps } = useSWR("coolify-apps", () => api.coolifyApps(), { refreshInterval: 60000 });
  const { data: alertsSummary } = useSWR("alerts-summary", () => api.alertsSummary(), { refreshInterval: 30000 });
  const { data: timeline } = useSWR("timeline-recent", () => api.timeline(undefined, 8), { refreshInterval: 15000 });
  const { data: sites } = useSWR("sites", () => api.sites(), { refreshInterval: 60000 });
  const { data: services } = useSWR("services-overview", () => api.services(), { refreshInterval: 60000 });
  const { data: deploys } = useSWR("deploys-recent", () => api.deploys(undefined), { refreshInterval: 60000 });

  // ── Containers reais validados com Zod (B-04) — alimenta KPIs + heatmap ─
  const containersNoc = useNoc(
    "containers",
    () => nocFetch("/srv1/containers", ContainerListSchema),
    30000
  );

  // ── Golden signals / health macro (endpoint FASE 3 → mock rotulado) ────
  const health = useNoc(
    "health",
    () => nocFetch("/analytics/health", HealthOverviewSchema, { mock: mockHealthOverview }),
    30000
  );

  const liveHost = useSocketEvent<any>("host:metrics");
  const liveContainers = useSocketEvent<any>("container:metrics");

  const h = liveHost || host;
  const cs = liveContainers?.containers || containersNoc.data || [];
  const running = cs.filter((c: any) => c.state === "running" || c.status?.startsWith("Up")).length;
  const healthy = cs.filter((c: any) => c.healthcheck === "healthy").length;
  const sitesUp = sites?.filter((s: any) => s.online).length ?? 0;
  const totalSites = sites?.length ?? 0;
  const appsCount = apps?.length ?? 0;

  // Health Score: usa RAG do backend; se ausente, deriva do score (invert: menor = pior).
  const score = health.data?.score ?? null;
  const scoreRag: Rag = health.data?.rag ?? ragOf(score, 80, 60, true);
  const mostImportant = health.data?.mostImportant ?? null;
  const miCritical = (mostImportant?.severity ?? "").toLowerCase().startsWith("crit");

  // Derive status de infra a partir de containers reais
  const infraStatus = INFRA_TARGETS.map(t => {
    const match = cs.find((c: any) => t.match((c.name || "").toLowerCase()));
    if (!match) return { ...t, status: "muted" as const, hint: "não encontrado" };
    if (match.healthcheck === "healthy") return { ...t, status: "healthy" as const, hint: match.uptime || "running" };
    if (match.healthcheck === "unhealthy") return { ...t, status: "red" as const, hint: "unhealthy" };
    if (match.state === "running") return { ...t, status: "running" as const, hint: match.uptime || "up" };
    return { ...t, status: "red" as const, hint: match.status || "down" };
  });

  // Failed services systemd reais
  const failedServices = (services || []).filter((s: any) => s.activeState === "failed");

  // Timeline → formato do EventTimeline (e.createdAt→ts)
  const timelineItems: TimelineItem[] = (timeline || []).map((e: any) => ({
    id: e.id,
    ts: e.createdAt,
    title: e.title,
    severity: e.severity,
    meta: `${e.actor ?? ""}${e.project ? " · " + e.project : ""}`
  }));

  const recentDeploys = (deploys || []).slice(0, 5);

  return (
    <div className="space-y-6 animate-fade-up">
      {/* HERO BAR — KPIs principais (dados reais) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 xl:grid-cols-6 gap-4">
        <KpiTile
          label="Containers"
          value={running}
          sub={`${cs.length} total · ${healthy} healthy`}
          accent="cyan"
          icon={<Boxes size={14} />}
        />
        <KpiTile
          label="Apps Coolify"
          value={appsCount}
          sub="repos prod"
          accent="accent"
          icon={<Server size={14} />}
        />
        <KpiTile
          label="Sites"
          value={`${sitesUp}/${totalSites}`}
          sub="online HTTP 2xx"
          accent={sitesUp === totalSites ? "green" : "yellow"}
          icon={<Globe size={14} />}
        />
        <KpiTile
          label="CPU srv1"
          value={`${h?.cpuPercent?.toFixed(1) ?? "—"}%`}
          sub={`load ${h?.loadAvg?.[0]?.toFixed(2) ?? "—"} / ${h?.loadAvg?.[1]?.toFixed(2) ?? "—"} / ${h?.loadAvg?.[2]?.toFixed(2) ?? "—"}`}
          accent={h?.cpuPercent > 80 ? "red" : h?.cpuPercent > 60 ? "yellow" : "green"}
          icon={<Cpu size={14} />}
        />
        <KpiTile
          label="RAM srv1"
          value={`${h?.memPercent?.toFixed(0) ?? "—"}%`}
          sub={`${((h?.memUsedMb ?? 0) / 1024).toFixed(1)}GB / ${((h?.memTotalMb ?? 0) / 1024).toFixed(1)}GB`}
          accent={h?.memPercent > 85 ? "red" : h?.memPercent > 70 ? "yellow" : "green"}
          icon={<MemoryStick size={14} />}
        />
        <KpiTile
          label="Alertas"
          value={alertsSummary?.last24h ?? 0}
          sub={`${alertsSummary?.critical ?? 0} críticos`}
          accent={(alertsSummary?.critical ?? 0) > 0 ? "red" : "green"}
          icon={<AlertTriangle size={14} />}
        />
      </div>

      {/* SAÚDE GLOBAL (golden signals) + MAIS IMPORTANTE AGORA */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6 lg:col-span-2">
          <div className="flex items-center gap-2 mb-4">
            <div className="section-title mb-0">Saúde global</div>
            <DataBadge source={health.source} stale={health.stale} />
          </div>
          {health.isLoading && !health.data ? (
            <div className="space-y-4">
              <Skeleton className="h-16 w-40" />
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                {[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-24" />)}
              </div>
            </div>
          ) : health.error && !health.data ? (
            <CardError message={health.error.message} onRetry={health.refresh} />
          ) : (
            <>
              <div className="flex items-end gap-4 mb-5">
                <div className="flex items-center gap-3">
                  <HeartPulse size={28} className="text-accent" aria-hidden="true" />
                  <span className="text-5xl font-bold text-mono">{score != null ? Math.round(score) : "—"}</span>
                  <span className="text-xs text-white/40 uppercase tracking-widest mb-1.5">/ 100</span>
                </div>
                <div className="mb-2">
                  <RagBadge rag={scoreRag} pulse />
                </div>
              </div>
              <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
                {SIGNAL_ORDER.map(({ key, fallbackLabel }) => {
                  const sig = health.data?.signals?.[key];
                  const rag: Rag = sig?.value == null ? "stale" : (sig?.rag ?? "stale");
                  return (
                    <div key={key} className="rounded-md border border-white/5 bg-white/[0.02] p-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-widest text-white/40">
                          {sig?.label ?? fallbackLabel}
                        </span>
                        <RagBadge rag={rag} />
                      </div>
                      <div className="text-xl font-bold text-mono mt-1">
                        {sig?.value != null ? sig.value : "—"}
                        <span className="text-[10px] text-white/40 font-normal ml-1">{sig?.unit ?? ""}</span>
                      </div>
                      <div className="mt-1">
                        <Sparkline data={sig?.spark ?? []} width={120} height={24} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {/* Mais importante agora — the single most important thing */}
        <div
          className={cn(
            "glass-card p-6 border",
            miCritical ? "border-red/40 shadow-red/10" : "border-yellow/40 shadow-yellow/10"
          )}
        >
          <div className="flex items-center gap-2 mb-3">
            <div className="section-title mb-0">Mais importante agora</div>
            <DataBadge source={health.source} stale={health.stale} />
          </div>
          {health.isLoading && !health.data ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-12" />
            </div>
          ) : health.error && !health.data ? (
            <CardError message={health.error.message} onRetry={health.refresh} />
          ) : mostImportant ? (
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <AlertTriangle size={18} className={cn("shrink-0 mt-0.5", miCritical ? "text-red" : "text-yellow")} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{mostImportant.title}</div>
                  {mostImportant.detail && (
                    <p className="text-xs text-white/50 mt-1 leading-relaxed">{mostImportant.detail}</p>
                  )}
                </div>
              </div>
              {mostImportant.href && (
                <Link href={mostImportant.href} className="btn text-xs inline-flex items-center gap-1.5">
                  Investigar <ArrowRight size={12} />
                </Link>
              )}
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs text-white/50 py-4">
              <CheckCircle2 size={14} className="text-green" /> Nada crítico agora. Tudo dentro dos limiares.
            </div>
          )}
        </div>
      </div>

      {/* CENTRO — Gauges real-time + Apps Coolify */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6">
          <div className="section-title">SRV1 — Real-time</div>
          <div className="grid grid-cols-3 gap-3 place-items-center">
            <Gauge value={h?.cpuPercent ?? 0} label="CPU" size={110} />
            <Gauge value={h?.memPercent ?? 0} label="RAM" size={110} />
            <Gauge value={h?.diskPercent ?? 0} label="DISK" size={110} thresholds={[70, 90]} />
          </div>
          <div className="grid grid-cols-3 gap-3 text-center mt-4 text-[10px] text-white/40 uppercase tracking-widest">
            <div>
              <Clock size={11} className="inline" />{" "}
              <span className="text-white/80">{h?.uptimeSeconds ? fmtUptime(h.uptimeSeconds) : "—"}</span>
              <div>uptime</div>
            </div>
            <div>
              <Zap size={11} className="inline" />{" "}
              <span className="text-white/80">{h?.netInBytes ? fmtBytes(Number(h.netInBytes)) : "—"}</span>
              <div>in / período</div>
            </div>
            <div>
              <HardDrive size={11} className="inline" />{" "}
              <span className="text-white/80">{h?.diskUsedGb?.toFixed(0)}/{h?.diskTotalGb?.toFixed(0)} GB</span>
              <div>disco</div>
            </div>
          </div>
        </div>

        <div className="glass-card p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">Apps Coolify</div>
            <Link href="/coolify" className="text-xs text-accent hover:underline">Ver tudo →</Link>
          </div>
          <div className="space-y-2 max-h-[280px] overflow-y-auto">
            {(apps || []).slice(0, 7).map((a: any) => (
              <div key={a.uuid} className="flex items-center justify-between p-2.5 rounded-md hover:bg-white/[0.03] transition group">
                <div className="flex items-center gap-3">
                  <span className={`w-2 h-2 rounded-full ${a.status?.includes("healthy") ? "bg-green" : a.status?.includes("running") ? "bg-cyan" : "bg-muted"}`} />
                  <div>
                    <div className="text-sm font-medium">{a.name}</div>
                    <div className="text-xs text-white/40 text-mono">{(a.fqdn || "").split(",")[0]}</div>
                  </div>
                </div>
                <StatusBadge status={a.status?.includes("healthy") ? "healthy" : a.status?.includes("running") ? "running" : "stopped"} pulse />
              </div>
            ))}
            {!apps && [1, 2, 3].map(i => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        </div>
      </div>

      {/* HEATMAP DE CONTAINERS — clique = drill-down /srv1/containers/[name] */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="section-title mb-0">Heatmap de containers</div>
            <DataBadge source={containersNoc.source} stale={containersNoc.stale} />
          </div>
          <span className="text-xs text-white/40 text-mono">{cs.length} containers · clique para drill-down</span>
        </div>
        {containersNoc.isLoading && !cs.length ? (
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 gap-2">
            {Array.from({ length: 16 }, (_, i) => <Skeleton key={i} className="h-12" />)}
          </div>
        ) : containersNoc.error && !cs.length ? (
          <CardError message={containersNoc.error.message} onRetry={containersNoc.refresh} />
        ) : (
          <ContainerHeatmap containers={cs} />
        )}
      </div>

      {/* TIMELINE + STATUS DE INFRA + DEPLOYS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">Timeline recente</div>
            <Link href="/alerts" className="text-xs text-accent hover:underline">Ver tudo →</Link>
          </div>
          <div className="max-h-[320px] overflow-y-auto">
            {!timeline ? (
              <div className="space-y-2">{[1, 2, 3, 4].map(i => <Skeleton key={i} className="h-10" />)}</div>
            ) : (
              <EventTimeline
                items={timelineItems}
                emptyMessage="Nenhum evento ainda. O coletor faz snapshots a cada 30s."
              />
            )}
          </div>
        </div>

        <div className="space-y-6">
          <div className="glass-card p-6">
            <div className="section-title">Status de infra</div>
            <div className="space-y-2.5 text-sm">
              {infraStatus.map(s => (
                <div key={s.key} className="flex items-center justify-between">
                  <span className="text-white/60">{s.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 text-mono">{s.hint}</span>
                    <StatusBadge status={s.status} pulse={s.status === "healthy" || s.status === "running"} label={s.status === "muted" ? "?" : undefined} />
                  </div>
                </div>
              ))}
              <div className="flex items-center justify-between">
                <span className="text-white/60">Failed services</span>
                <StatusBadge
                  status={failedServices.length === 0 ? "healthy" : failedServices.length < 3 ? "warning" : "red"}
                  label={failedServices.length === 0 ? "0" : `${failedServices.length} atenção`}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-white/60">Containers healthy</span>
                <StatusBadge
                  status={healthy === cs.length && cs.length > 0 ? "healthy" : healthy > 0 ? "warning" : "muted"}
                  label={`${healthy}/${cs.length}`}
                />
              </div>
              <div className="border-t border-white/5 mt-3 pt-3 flex items-center justify-between">
                <span className="text-white/70 flex items-center gap-1.5">
                  <ShieldAlert size={12} aria-hidden="true" /> Last refresh
                </span>
                <span className="text-mono text-xs text-white/60" title={new Date().toLocaleString("pt-BR")}>
                  {host ? new Date().toLocaleTimeString("pt-BR") : "—"}
                </span>
              </div>
            </div>
          </div>

          {/* Deploys recentes (dados reais /deploys) */}
          <div className="glass-card p-6">
            <div className="flex items-center gap-2 mb-3">
              <Rocket size={13} className="text-accent" aria-hidden="true" />
              <div className="section-title mb-0">Deploys recentes</div>
            </div>
            {!deploys ? (
              <div className="space-y-2">{[1, 2, 3].map(i => <Skeleton key={i} className="h-8" />)}</div>
            ) : recentDeploys.length === 0 ? (
              <div className="text-center py-4 text-xs text-white/40">Nenhum deploy registrado.</div>
            ) : (
              <div className="space-y-1.5 text-sm">
                {recentDeploys.map((d: any, i: number) => {
                  const ok = d.status === "success";
                  const when = d.finishedAt ?? d.startedAt ?? d.createdAt;
                  return (
                    <div key={d.id ?? i} className="flex items-center justify-between p-2 rounded hover:bg-white/[0.03]">
                      <div className="flex items-center gap-2 min-w-0">
                        {ok ? (
                          <CheckCircle2 size={14} className="text-green shrink-0" aria-label="sucesso" />
                        ) : (
                          <XCircle size={14} className="text-red shrink-0" aria-label="falhou" />
                        )}
                        <span className="truncate text-xs font-medium">{d.project}</span>
                      </div>
                      <span className="text-[10px] text-white/40 text-mono shrink-0 ml-2">
                        {when ? new Date(when).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
