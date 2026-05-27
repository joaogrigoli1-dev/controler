"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { KpiTile } from "@/components/ui/KpiTile";
import { LineChart, Line, BarChart, Bar, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from "recharts";
import { TrendingUp, AlertCircle, Rocket } from "lucide-react";

export default function AnalyticsPage() {
  const { data: overview } = useSWR("an-overview-7", () => api.analyticsOverview(7));
  const { data: hist } = useSWR("an-host-24h", () => api.hostHistory(24));
  const { data: deployStats } = useSWR("an-deploys", () => api.deployStats());
  const { data: heat } = useSWR("an-heat", () => api.heatmap());

  const histData = (hist || []).map((p: any) => ({
    t: new Date(p.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit" }),
    cpu: p.cpuPercent,
    mem: Math.round((p.memUsedMb / p.memTotalMb) * 100)
  }));

  const heatData = Object.entries(heat || {}).map(([k, v]: any) => ({ hour: k, ...v }));
  const deployArr = Object.entries(deployStats || {}).map(([proj, st]: any) => ({ proj, ...st }));

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiTile
          label="Deploys 7d"
          value={overview?.deploys?.current ?? 0}
          delta={overview?.deploys?.delta}
          trend={overview?.deploys?.delta > 0 ? "up" : overview?.deploys?.delta < 0 ? "down" : "flat"}
          accent="accent"
          icon={<Rocket size={14} />}
        />
        <KpiTile
          label="Alertas 7d"
          value={overview?.alerts?.current ?? 0}
          delta={overview?.alerts?.delta}
          trend={overview?.alerts?.delta > 0 ? "up" : "down"}
          accent="yellow"
          icon={<AlertCircle size={14} />}
        />
        <KpiTile label="Críticos 7d" value={overview?.alerts?.critical ?? 0} accent="red" />
        <KpiTile label="MTTR (min)" value={overview?.mttrMinutes ?? "—"} accent="cyan" icon={<TrendingUp size={14} />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-6">
          <div className="section-title">CPU / RAM — 24h</div>
          <div className="h-[260px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={histData}>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" />
                <XAxis dataKey="t" tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} />
                <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "hsl(240 18% 8%)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="cpu" stroke="hsl(191 87% 53%)" dot={false} strokeWidth={2} name="CPU%" />
                <Line type="monotone" dataKey="mem" stroke="hsl(248 92% 70%)" dot={false} strokeWidth={2} name="RAM%" />
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
                <YAxis tick={{ fill: "rgba(255,255,255,0.4)", fontSize: 10 }} />
                <Tooltip contentStyle={{ background: "hsl(240 18% 8%)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12 }} />
                <Bar dataKey="info" stackId="a" fill="hsl(191 87% 53%)" />
                <Bar dataKey="warning" stackId="a" fill="hsl(45 95% 53%)" />
                <Bar dataKey="critical" stackId="a" fill="hsl(0 90% 71%)" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="glass-card p-6">
        <div className="section-title">Deploys por projeto (30d)</div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {deployArr.map((d: any) => (
            <div key={d.proj} className="p-3 rounded bg-white/[0.03]">
              <div className="font-medium">{d.proj}</div>
              <div className="text-xs text-white/40 text-mono">
                {d.total} deploys · {d.success} ✓ · {d.failed} ✗
              </div>
              <div className="mt-2 h-1 bg-white/5 rounded-full overflow-hidden">
                <div className="h-full bg-green" style={{ width: `${(d.success / d.total) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
