"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { KpiTile } from "@/components/ui/KpiTile";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid, Legend
} from "recharts";
import {
  TrendingUp, AlertCircle, Rocket, Activity, ShieldAlert, Server,
  Cpu, MemoryStick, CheckCircle2, Globe, Zap
} from "lucide-react";

const TOOLTIP_STYLE: React.CSSProperties = {
  background: "hsl(240 18% 8%)",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 8,
  fontSize: 12
};

const SEV_COLORS = {
  info: "hsl(191 87% 53%)",
  warning: "hsl(45 95% 53%)",
  critical: "hsl(0 90% 71%)"
};

export default function AnalyticsPage() {
  const { data: overview } = useSWR("an-overview-7", () => api.analyticsOverview(7), { refreshInterval: 60000 });
  const { data: hist } = useSWR("an-host-24h", () => api.hostHistory(24), { refreshInterval: 60000 });
  const { data: deployStats } = useSWR("an-deploys", () => api.deployStats(), { refreshInterval: 60000 });
  const { data: heat } = useSWR("an-heat", () => api.heatmap(), { refreshInterval: 60000 });
  const { data: uptime } = useSWR("an-uptime", () => api.hostUptime(24), { refreshInterval: 120000 });
  const { data: topCpu } = useSWR("an-top-cpu", () => api.topContainers("cpu", 24, 5), { refreshInterval: 60000 });
  const { data: topMem } = useSWR("an-top-mem", () => api.topContainers("mem", 24, 5), { refreshInterval: 60000 });
  const { data: alertsBd } = useSWR("an-alerts-bd", () => api.alertsBreakdown(168), { refreshInterval: 60000 });

  const histData = (hist || []).map((p: any) => ({
    t: new Date(p.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    cpu: p.cpuPercent,
    mem: Math.round((p.memUsedMb / p.memTotalMb) * 100)
  }));

  const heatData = Object.entries(heat || {}).map(([k, v]: any) => ({ hour: k, ...v }));
  const deployArr = Object.entries(deployStats || {}).map(([proj, st]: any) => ({ proj, ...st }));

  // KPIs derivados
  const sitesUptime = overview?.sites?.total
    ? Math.round((overview.sites.online / overview.sites.total) * 100)
    : null;
  const apisUptime = overview?.apis?.total
    ? Math.round((overview.apis.healthy / overview.apis.total) * 100)
    : null;

  // Pie distribuição severidade
  const sevPie = alertsBd
    ? Object.entries(alertsBd.bySeverity || {})
        .filter(([, n]: any) => n > 0)
        .map(([sev, n]: any) => ({ name: sev, value: n }))
    : [];

  return (
    <div className="space-y-6 animate-fade-up">
      {/* HERO KPIs — linha 1 (operacionais) */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KpiTile
          label="Deploys 7d"
          value={overview?.deploys?.current ?? 0}
          delta={overview?.deploys?.delta}
          trend={(overview?.deploys?.delta ?? 0) > 0 ? "up" : (overview?.deploys?.delta ?? 0) < 0 ? "down" : "flat"}
          sub={overview?.deploys?.successRate != null ? `${overview.deploys.successRate}% success` : undefined}
          accent="accent"
          icon={<Rocket size={14} />}
        />
        <KpiTile
          label="MTTR"
          value={overview?.mttrMinutes ?? "—"}
          sub="min (fail → fix)"
          accent="cyan"
          icon={<TrendingUp size={14} />}
        />
        <KpiTile
          label="Alertas 7d"
          value={overview?.alerts?.current ?? 0}
          delta={overview?.alerts?.delta}
          trend={(overview?.alerts?.delta ?? 0) > 0 ? "up" : "down"}
          accent="yellow"
          icon={<AlertCircle size={14} />}
        />
        <KpiTile
          label="Críticos 7d"
          value={overview?.alerts?.critical ?? 0}
          sub={`${overview?.alerts?.warning ?? 0} warnings`}
          accent={(overview?.alerts?.critical ?? 0) > 0 ? "red" : "green"}
          icon={<ShieldAlert size={14} />}
        />
        <KpiTile
          label="Uptime SRV1 24h"
          value={uptime?.uptimePercent != null ? `${uptime.uptimePercent}%` : "—"}
          sub={`${uptime?.samples ?? 0} snapshots`}
          accent={uptime?.uptimePercent && uptime.uptimePercent > 95 ? "green" : "yellow"}
          icon={<Server size={14} />}
        />
        <KpiTile
          label="Scanner aberto"
          value={overview?.scanner?.openFindings ?? 0}
          sub="findings não resolvidos"
          accent={(overview?.scanner?.openFindings ?? 0) > 5 ? "red" : "green"}
          icon={<Activity size={14} />}
        />
      </div>

      {/* HERO KPIs — linha 2 (saúde de superfície) */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiTile
          label="Sites online"
          value={`${overview?.sites?.online ?? 0}/${overview?.sites?.total ?? 0}`}
          sub={sitesUptime != null ? `${sitesUptime}% disponível` : undefined}
          accent={sitesUptime != null && sitesUptime >= 95 ? "green" : sitesUptime != null && sitesUptime >= 80 ? "yellow" : "red"}
          icon={<Globe size={14} />}
        />
        <KpiTile
          label="APIs healthy"
          value={`${overview?.apis?.healthy ?? 0}/${overview?.apis?.total ?? 0}`}
          sub={apisUptime != null ? `${apisUptime}% verde` : "sem dados"}
          accent={apisUptime != null && apisUptime >= 95 ? "green" : apisUptime != null && apisUptime >= 70 ? "yellow" : "red"}
          icon={<Zap size={14} />}
        />
        <KpiTile
          label="Deploys ok / fail"
          value={`${overview?.deploys?.success ?? 0} / ${overview?.deploys?.failed ?? 0}`}
          sub="7d"
          accent={(overview?.deploys?.failed ?? 0) === 0 ? "green" : "yellow"}
          icon={<CheckCircle2 size={14} />}
        />
        <KpiTile
          label="Alertas 24h delivery"
          value={alertsBd?.delivery?.rate != null ? `${alertsBd.delivery.rate}%` : "—"}
          sub={`${alertsBd?.delivery?.sent ?? 0} sent · ${alertsBd?.delivery?.failed ?? 0} fail`}
          accent={alertsBd?.delivery?.rate != null && alertsBd.delivery.rate >= 95 ? "green" : "yellow"}
          icon={<Activity size={14} />}
        />
      </div>

      {/* CHARTS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-6">
          <div className="section-title">CPU / RAM — Últimas 24h</div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={histData}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="t" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} domain={[0, 100]} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }} />
                <Line type="monotone" dataKey="cpu" stroke="hsl(191 87% 53%)" dot={false} strokeWidth={2} name="CPU %" />
                <Line type="monotone" dataKey="mem" stroke="hsl(248 92% 70%)" dot={false} strokeWidth={2} name="RAM %" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="glass-card p-6">
          <div className="section-title">Heatmap eventos 24h</div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={heatData}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="hour" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} allowDecimals={false} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }} />
                <Bar dataKey="info" stackId="a" fill={SEV_COLORS.info} />
                <Bar dataKey="warning" stackId="a" fill={SEV_COLORS.warning} />
                <Bar dataKey="critical" stackId="a" fill={SEV_COLORS.critical} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* TOP CONTAINERS + PIE */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6">
          <div className="section-title flex items-center gap-2"><Cpu size={12} /> Top CPU (24h)</div>
          <div className="space-y-2 text-xs">
            {(topCpu || []).map((c: any, i: number) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="text-mono text-white/40 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-mono truncate" title={c.name}>{c.name}</div>
                  <div className="h-1 mt-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-cyan"
                      style={{ width: `${Math.min(100, c.avgCpu)}%` }}
                    />
                  </div>
                </div>
                <span className="text-mono text-cyan">{c.avgCpu}%</span>
              </div>
            ))}
            {!topCpu?.length && <div className="text-white/40 py-8 text-center">Sem dados de 24h</div>}
          </div>
        </div>

        <div className="glass-card p-6">
          <div className="section-title flex items-center gap-2"><MemoryStick size={12} /> Top RAM (24h)</div>
          <div className="space-y-2 text-xs">
            {(topMem || []).map((c: any, i: number) => (
              <div key={c.name} className="flex items-center gap-3">
                <span className="text-mono text-white/40 w-4">{i + 1}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-mono truncate" title={c.name}>{c.name}</div>
                  <div className="h-1 mt-1 bg-white/5 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-accent"
                      style={{ width: `${Math.min(100, c.avgMem)}%` }}
                    />
                  </div>
                </div>
                <span className="text-mono text-accent">{c.avgMem}%</span>
              </div>
            ))}
            {!topMem?.length && <div className="text-white/40 py-8 text-center">Sem dados de 24h</div>}
          </div>
        </div>

        <div className="glass-card p-6">
          <div className="section-title">Distribuição alertas 7d</div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={sevPie}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  outerRadius={70}
                  innerRadius={40}
                  paddingAngle={2}
                >
                  {sevPie.map((d: any) => (
                    <Cell key={d.name} fill={SEV_COLORS[d.name as keyof typeof SEV_COLORS] || "#888"} />
                  ))}
                </Pie>
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontSize: 11, color: "rgba(255,255,255,0.6)" }} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {alertsBd?.byChannel && Object.keys(alertsBd.byChannel).length > 0 && (
            <div className="mt-2 pt-2 border-t border-white/5 text-[10px] text-white/40 flex flex-wrap gap-2">
              {Object.entries(alertsBd.byChannel).map(([ch, n]: any) => (
                <span key={ch} className="text-mono">
                  <span className="text-cyan">{ch}</span>:{n}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* DEPLOYS POR PROJETO */}
      <div className="glass-card p-6">
        <div className="section-title">Deploys por projeto (30d)</div>
        {deployArr.length === 0 && (
          <div className="text-white/40 text-sm py-6 text-center">
            Nenhum deploy registrado nos últimos 30 dias.
          </div>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {deployArr.map((d: any) => {
            const pct = d.total > 0 ? Math.round((d.success / d.total) * 100) : 0;
            return (
              <div key={d.proj} className="p-3 rounded bg-white/[0.03] border border-white/5">
                <div className="flex items-center justify-between">
                  <div className="font-medium">{d.proj}</div>
                  <span
                    className={`text-mono text-xs ${
                      pct >= 95 ? "text-green" : pct >= 80 ? "text-yellow" : "text-red"
                    }`}
                  >
                    {pct}%
                  </span>
                </div>
                <div className="text-xs text-white/40 text-mono mt-1">
                  {d.total} deploys · {d.success} ✓ · {d.failed} ✗
                  {d.avgDuration > 0 && ` · ${Math.round(d.avgDuration)}s avg`}
                </div>
                <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${pct >= 95 ? "bg-green" : pct >= 80 ? "bg-yellow" : "bg-red"}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
