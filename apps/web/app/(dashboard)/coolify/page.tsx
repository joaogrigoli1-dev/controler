"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { GitBranch, ExternalLink, RefreshCcw, Terminal } from "lucide-react";
import { useState } from "react";

export default function CoolifyPage() {
  const { data: apps, mutate } = useSWR("coolify-list", () => api.coolifyApps(), { refreshInterval: 30000 });
  const [selected, setSelected] = useState<string | null>(null);
  const { data: envs } = useSWR(selected ? `envs-${selected}` : null, () => selected ? api.coolifyEnvs(selected) : null);
  const { data: logs } = useSWR(selected ? `logs-${selected}` : null, () => selected ? api.coolifyLogs(selected, 100) : null, { refreshInterval: 10000 });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 animate-fade-up">
      <div className="lg:col-span-2 space-y-4">
        <div className="flex items-center justify-between">
          <div className="text-sm text-white/60">{apps?.length ?? 0} aplicações</div>
          <button onClick={() => mutate()} className="btn"><RefreshCcw size={12} /> Refresh</button>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(apps || []).map((a: any) => {
            const isHealthy = a.status?.includes("healthy");
            const isRunning = a.status?.includes("running");
            const isSelected = selected === a.uuid;
            return (
              <div
                key={a.uuid}
                onClick={() => setSelected(a.uuid)}
                className={`glass-card p-5 cursor-pointer transition-all ${isSelected ? "ring-1 ring-accent" : ""}`}
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="text-display font-semibold">{a.name}</div>
                    <a href={`https://${(a.fqdn || "").split(",")[0]}`} target="_blank" rel="noreferrer"
                       className="text-xs text-cyan hover:underline text-mono flex items-center gap-1 mt-0.5"
                       onClick={e => e.stopPropagation()}>
                      {(a.fqdn || "").split(",")[0]} <ExternalLink size={10} />
                    </a>
                  </div>
                  <StatusBadge status={isHealthy ? "healthy" : isRunning ? "running" : "stopped"} pulse />
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="text-white/40 flex items-center gap-1"><GitBranch size={11} /> {a.git_branch || "main"}</div>
                  <div className="text-white/40 text-right text-mono">{(a.git_commit_sha || "").slice(0, 7) || "—"}</div>
                </div>
                <div className="text-[10px] text-white/30 text-mono mt-2 truncate">{a.uuid}</div>
              </div>
            );
          })}
          {!apps && [1,2,3,4,5,6].map(i => (
            <div key={i} className="glass-card h-32 animate-pulse" />
          ))}
        </div>
      </div>

      <div className="space-y-4">
        <div className="glass-card p-5">
          <div className="section-title">Detalhes</div>
          {!selected && <p className="text-xs text-white/40">Clique numa app à esquerda para ver envs e logs.</p>}
          {selected && envs && (
            <div className="space-y-2 text-xs max-h-[260px] overflow-y-auto">
              {(envs || []).map((e: any) => (
                <div key={e.id || e.key} className="flex items-center justify-between p-1.5 rounded bg-white/[0.03]">
                  <span className="text-mono text-white/80">{e.key}</span>
                  <span className="text-mono text-white/40">{e.is_secret ? "••••" : (e.value || "").slice(0, 20)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="glass-card p-5">
          <div className="flex items-center gap-2 mb-2">
            <Terminal size={14} className="text-cyan" />
            <span className="section-title mb-0">Logs (100 linhas)</span>
          </div>
          <pre className="text-[10px] text-mono text-white/60 bg-black/40 p-3 rounded h-[300px] overflow-auto whitespace-pre-wrap">
            {selected ? (logs?.logs || "Carregando…") : "Selecione uma app"}
          </pre>
        </div>
      </div>
    </div>
  );
}
