"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useSocketEvent } from "@/lib/socket";
import { KpiTile } from "@/components/ui/KpiTile";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Gauge } from "@/components/ui/Gauge";
import { fmtUptime, fmtBytes, severityColor } from "@/lib/utils";
import {
  Server, Boxes, Globe, AlertTriangle, Activity, Cpu, MemoryStick, HardDrive,
  Zap, Clock, ShieldAlert
} from "lucide-react";

// Containers críticos de infra que devem aparecer no painel "Status Geral".
// Cada entry tem regex/substring matcher + label público + classificação.
const INFRA_TARGETS: Array<{ key: string; label: string; match: (name: string) => boolean }> = [
  { key: "postgres", label: "Postgres main", match: n => /^postgres-main|^postgresql-|postgres$/.test(n) },
  { key: "redis", label: "Redis", match: n => /redis/.test(n) },
  { key: "traefik", label: "Traefik proxy", match: n => /traefik|coolify-proxy/.test(n) },
  { key: "mail", label: "Mail (Stalwart)", match: n => /^mailserver|stalwart/.test(n) }
];

export default function OverviewPage() {
  const { data: host } = useSWR("host", () => api.hostMetrics(), { refreshInterval: 30000 });
  const { data: containers } = useSWR("containers", () => api.containers(), { refreshInterval: 30000 });
  const { data: apps } = useSWR("coolify-apps", () => api.coolifyApps(), { refreshInterval: 60000 });
  const { data: alertsSummary } = useSWR("alerts-summary", () => api.alertsSummary(), { refreshInterval: 30000 });
  const { data: timeline } = useSWR("timeline-recent", () => api.timeline(undefined, 8), { refreshInterval: 15000 });
  const { data: sites } = useSWR("sites", () => api.sites(), { refreshInterval: 60000 });
  const { data: services } = useSWR("services-overview", () => api.services(), { refreshInterval: 60000 });
  const liveHost = useSocketEvent<any>("host:metrics");
  const liveContainers = useSocketEvent<any>("container:metrics");

  const h = liveHost || host;
  const cs = liveContainers?.containers || containers || [];
  const running = cs.filter((c: any) => c.state === "running" || c.status?.startsWith("Up")).length;
  const healthy = cs.filter((c: any) => c.healthcheck === "healthy").length;
  const sitesUp = sites?.filter((s: any) => s.online).length ?? 0;
  const totalSites = sites?.length ?? 0;
  const appsCount = apps?.length ?? 0;

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

  return (
    <div className="space-y-6 animate-fade-up">
      {/* HERO BAR — KPIs principais */}
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

      {/* CENTRO — Gauges + Atalhos */}
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
            <a href="/coolify" className="text-xs text-accent hover:underline">Ver tudo →</a>
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
              <div key={i} className="h-12 bg-white/[0.03] rounded-md animate-pulse" />
            ))}
          </div>
        </div>
      </div>

      {/* TIMELINE + ALERTAS */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">Timeline recente</div>
            <a href="#" className="text-xs text-accent hover:underline">Filtrar →</a>
          </div>
          <div className="space-y-2 max-h-[320px] overflow-y-auto">
            {(timeline || []).map((e: any) => (
              <div key={e.id} className="flex items-start gap-3 p-2.5 rounded-md hover:bg-white/[0.03]">
                <span className={`w-1.5 h-1.5 rounded-full mt-1.5 bg-${severityColor(e.severity)}`} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm">{e.title}</div>
                  <div className="text-[10px] text-white/40 text-mono">
                    {new Date(e.createdAt).toLocaleTimeString("pt-BR")} · {e.actor} {e.project && `· ${e.project}`}
                  </div>
                </div>
                <StatusBadge status={e.severity} />
              </div>
            ))}
            {!timeline?.length && (
              <div className="text-center py-10 text-white/30">
                <Activity size={28} className="mx-auto mb-2 opacity-40" />
                <p className="text-xs">Nenhum evento ainda. O coletor faz snapshots a cada 30s.</p>
              </div>
            )}
          </div>
        </div>

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
      </div>
    </div>
  );
}
