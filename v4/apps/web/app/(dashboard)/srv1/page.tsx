"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { useSocketEvent } from "@/lib/socket";
import { Gauge } from "@/components/ui/Gauge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { fmtUptime, fmtBytes, statusColor } from "@/lib/utils";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";
import { Cpu, MemoryStick, HardDrive, Activity, Network, Terminal } from "lucide-react";

export default function Srv1Page() {
  const { data: host } = useSWR("host-deep", () => api.hostMetrics(), { refreshInterval: 30000 });
  const { data: services } = useSWR("services", () => api.services(), { refreshInterval: 60000 });
  const { data: procs } = useSWR("procs", () => api.processes("cpu"), { refreshInterval: 30000 });
  const { data: ports } = useSWR("ports", () => api.ports(), { refreshInterval: 120000 });
  const { data: hist } = useSWR("host-history", () => api.hostHistory(6), { refreshInterval: 60000 });
  const liveHost = useSocketEvent<any>("host:metrics");

  const h = liveHost || host;
  const histData = (hist || []).map((p: any) => ({
    t: new Date(p.createdAt).getTime(),
    cpu: p.cpuPercent,
    mem: (p.memUsedMb / p.memTotalMb) * 100
  }));

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiTile label="Uptime" value={h?.uptimeSeconds ? fmtUptime(h.uptimeSeconds) : "—"} sub="desde último reboot" icon={<Activity size={14} />} accent="green" />
        <KpiTile label="Load avg" value={h?.loadAvg?.[0]?.toFixed(2) ?? "—"} sub={`5m: ${h?.loadAvg?.[1]?.toFixed(2) ?? "—"} · 15m: ${h?.loadAvg?.[2]?.toFixed(2) ?? "—"}`} icon={<Cpu size={14} />} accent="cyan" />
        <KpiTile label="Net in" value={fmtBytes(Number(h?.netInBytes || 0))} icon={<Network size={14} />} sub="último período" />
        <KpiTile label="Net out" value={fmtBytes(Number(h?.netOutBytes || 0))} icon={<Network size={14} />} sub="último período" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6">
          <div className="section-title">Gauges em tempo real</div>
          <div className="grid grid-cols-3 gap-4 place-items-center">
            <Gauge value={h?.cpuPercent ?? 0} label="CPU" size={120} />
            <Gauge value={h?.memPercent ?? 0} label="RAM" size={120} />
            <Gauge value={h?.diskPercent ?? 0} label="DISK" size={120} thresholds={[75, 90]} />
          </div>
        </div>
        <div className="glass-card p-6 lg:col-span-2">
          <div className="section-title">CPU / RAM — Últimas 6h</div>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={histData}>
                <Tooltip contentStyle={{ background: "hsl(240 18% 8%)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, fontSize: 12 }} />
                <Line type="monotone" dataKey="cpu" stroke="hsl(191 87% 53%)" dot={false} strokeWidth={2} name="CPU%" />
                <Line type="monotone" dataKey="mem" stroke="hsl(248 92% 70%)" dot={false} strokeWidth={2} name="RAM%" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-6">
          <div className="section-title">Serviços systemd</div>
          <div className="space-y-1.5 text-sm">
            {(services || []).map((s: any) => (
              <div key={s.name} className="flex items-center justify-between p-2 rounded hover:bg-white/[0.03]">
                <div>
                  <div className="text-mono text-xs text-white/90">{s.name}</div>
                  <div className="text-[10px] text-white/40">{s.description}</div>
                </div>
                <StatusBadge status={s.activeState === "active" ? "running" : s.activeState === "failed" ? "red" : "muted"} label={s.subState} />
              </div>
            ))}
          </div>
        </div>
        <div className="glass-card p-6">
          <div className="section-title">Top processos (CPU)</div>
          <table className="w-full text-xs">
            <thead className="text-white/40 text-[10px] uppercase tracking-widest">
              <tr><th className="text-left py-2">PID</th><th className="text-left">User</th><th className="text-right">CPU%</th><th className="text-right">MEM%</th><th className="text-left pl-3">Cmd</th></tr>
            </thead>
            <tbody>
              {(procs || []).slice(0, 8).map((p: any) => (
                <tr key={p.pid} className="border-t border-white/5">
                  <td className="py-1.5 text-mono">{p.pid}</td>
                  <td className="text-white/60">{p.user}</td>
                  <td className="text-right text-mono">{p.cpu?.toFixed(1)}</td>
                  <td className="text-right text-mono">{p.mem?.toFixed(1)}</td>
                  <td className="pl-3 text-white/60 truncate max-w-[280px]" title={p.command}>{p.command}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title mb-0">Portas em escuta</div>
          <span className="text-xs text-white/40 text-mono">{ports?.length ?? 0} sockets</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
          {(ports || []).map((p: any, i: number) => (
            <div key={i} className="flex items-center justify-between p-2 rounded bg-white/[0.02]">
              <span className="text-mono text-cyan">{p.local}</span>
              <span className="text-white/40">{p.process}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
