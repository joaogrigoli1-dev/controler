"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CardError } from "@/components/noc/CardError";
import { Zap, ExternalLink, KeyRound } from "lucide-react";

export default function ApisPage() {
  // R11 (FASE 5): error state visível + retry (tela pré-FASE 4)
  const { data: apis, error: apisError, mutate } = useSWR("apis", () => api.apis(), { refreshInterval: 60000 });

  const grouped: Record<string, any[]> = {};
  (apis || []).forEach((a: any) => {
    const k = a.project?.slug || "geral";
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(a);
  });

  const ping = async () => {
    await api.apisPing();
    mutate();
  };

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="flex items-center justify-between">
        <div className="text-sm text-white/60">{apis?.length ?? 0} integrações monitoradas</div>
        <button onClick={ping} className="btn btn-primary"><Zap size={12} /> Pingar todas</button>
      </div>

      {apisError && !apis && (
        <CardError message={`Erro ao carregar integrações: ${apisError.message}`} onRetry={() => void mutate()} />
      )}

      {Object.entries(grouped).map(([prj, items]) => (
        <div key={prj} className="glass-card p-6">
          <div className="section-title flex items-center gap-2">
            <span>{items[0]?.project?.icon || "📦"}</span>
            {items[0]?.project?.name || prj}
            <span className="text-white/60 text-mono">({items.length})</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {items.map((a: any) => (
              <div key={a.id} className="p-4 rounded-md bg-white/[0.03] border border-white/5 hover:border-white/10 transition">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-medium">{a.name}</div>
                    <div className="text-xs text-mono text-white/40 mt-0.5">{a.baseUrl}</div>
                  </div>
                  <StatusBadge status={a.status || "info"} pulse={a.status === "healthy"} />
                </div>
                <div className="mt-3 flex items-center gap-3 text-xs text-white/40">
                  <span>env: <span className="text-cyan">{a.environment}</span></span>
                  {a.responseTimeMs != null && <span>· {a.responseTimeMs}ms</span>}
                  {a.lastChecked && <span>· {new Date(a.lastChecked).toLocaleTimeString("pt-BR")}</span>}
                </div>
                {a.ssmKeyPath && (
                  <div className="mt-2 flex items-center gap-1 text-xs text-mono text-purple">
                    <KeyRound size={10} /> {a.ssmKeyPath}
                  </div>
                )}
                {a.docsUrl && (
                  <a href={a.docsUrl} target="_blank" rel="noreferrer" className="text-xs text-cyan hover:underline flex items-center gap-1 mt-2">
                    docs <ExternalLink size={9} />
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
