"use client";
import useSWR from "swr";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CardError } from "@/components/noc/CardError";
import { ShieldCheck, ExternalLink, Globe, Mail } from "lucide-react";

export default function HestiaPage() {
  // R11 (FASE 5): error state visível + retry (tela pré-FASE 4)
  const { data: sites, error: sitesError, mutate: mutateSites } = useSWR("sites-all", () => api.sites(), { refreshInterval: 60000 });
  const { data: mail, error: mailError, mutate: mutateMail } = useSWR("mail-stack", () => api.mail(), { refreshInterval: 60000 });

  const grouped: Record<string, any[]> = {};
  (sites || []).forEach((s: any) => {
    const k = s.scope || "other";
    if (!grouped[k]) grouped[k] = [];
    grouped[k].push(s);
  });

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="glass-card p-6">
        <div className="section-title flex items-center gap-2"><Mail size={12} aria-hidden="true" /> Mail Stack</div>
        {mailError && !mail && (
          <CardError message={`Erro ao carregar o mail stack: ${mailError.message}`} onRetry={() => void mutateMail()} />
        )}
        {!mail && !mailError && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="h-20 rounded-md bg-white/[0.03] animate-pulse" />
            ))}
          </div>
        )}
        {mail?.length === 0 && (
          <div className="text-center py-8 text-white/60 text-sm">
            Nenhum container de mail rodando
          </div>
        )}
        {mail && mail.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {mail.map((m: any) => (
              <div key={m.name} className="p-3 rounded-md bg-white/[0.03] border border-white/5">
                <div className="text-sm text-mono truncate" title={m.name}>{m.name}</div>
                <div className="text-[10px] text-white/60 mt-1 truncate" title={m.image}>{m.image}</div>
                <div className="mt-2"><StatusBadge status={m.status?.startsWith("Up") ? "healthy" : "muted"} pulse /></div>
              </div>
            ))}
          </div>
        )}
      </div>

      {sitesError && !sites && (
        <div className="glass-card p-6">
          <CardError message={`Erro ao carregar os sites: ${sitesError.message}`} onRetry={() => void mutateSites()} />
        </div>
      )}

      {Object.entries(grouped).map(([scope, items]) => (
        <div key={scope} className="glass-card p-6">
          <div className="section-title flex items-center gap-2"><Globe size={12} /> {scope.toUpperCase()} ({items.length})</div>
          <div className="space-y-2">
            {items.map((s: any) => {
              const sslDaysLeft = s.sslExpiresAt
                ? Math.ceil((new Date(s.sslExpiresAt).getTime() - Date.now()) / (24 * 3600 * 1000))
                : null;
              return (
                <div key={s.domain} className="flex items-center gap-4 p-3 rounded-md bg-white/[0.02] hover:bg-white/[0.04] transition">
                  <span className={`w-2 h-2 rounded-full ${s.online ? "bg-green" : "bg-red"}`} />
                  <div className="flex-1 min-w-0">
                    <a href={`https://${s.domain}`} target="_blank" rel="noreferrer" className="font-medium text-mono hover:text-cyan flex items-center gap-1">
                      {s.domain} <ExternalLink size={10} className="opacity-50" />
                    </a>
                    <div className="text-[10px] text-white/40 text-mono">{s.containerName || "—"}</div>
                  </div>
                  <div className="flex items-center gap-4 text-xs">
                    {s.statusCode && (
                      <StatusBadge status={s.statusCode < 400 ? "green" : s.statusCode < 500 ? "yellow" : "red"} label={`HTTP ${s.statusCode}`} />
                    )}
                    {s.responseMs != null && (
                      <span className="text-mono text-white/40">{s.responseMs}ms</span>
                    )}
                    {sslDaysLeft != null && (
                      <span className={`flex items-center gap-1 text-mono ${sslDaysLeft < 30 ? "text-yellow" : "text-white/60"}`}>
                        <ShieldCheck size={10} /> {sslDaysLeft}d
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
