"use client";
import useSWR from "swr";
import { useState } from "react";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { Send, AlertCircle, Bell, Clock } from "lucide-react";

export default function AlertsPage() {
  const { data: summary } = useSWR("alerts-sum", () => api.alertsSummary(), { refreshInterval: 30000 });
  const { data: logs, mutate } = useSWR("alerts-logs", () => api.alerts(), { refreshInterval: 30000 });
  const { data: rules } = useSWR("alerts-rules", () => api.alertsRules(), { refreshInterval: 120000 });
  const [test, setTest] = useState({ severity: "warning", title: "Teste", message: "Mensagem de teste" });
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<any>(null);

  const send = async () => {
    setSending(true);
    setResult(null);
    try {
      const r = await api.alertsTest(test);
      setResult(r);
      mutate();
    } catch (e: any) {
      setResult({ error: e?.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <KpiTile label="Total" value={summary?.total ?? 0} accent="cyan" icon={<Bell size={14} />} />
        <KpiTile label="Críticos" value={summary?.critical ?? 0} accent="red" />
        <KpiTile label="Warnings" value={summary?.warning ?? 0} accent="yellow" />
        <KpiTile label="24h" value={summary?.last24h ?? 0} accent="accent" sub="últimos disparos" />
        <KpiTile label="Silenciados" value={summary?.silenced ?? 0} icon={<Clock size={14} />} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6">
          <div className="section-title flex items-center gap-2"><Send size={12} /> Testar alerta</div>
          <div className="space-y-3">
            <div>
              <label className="text-xs text-white/40">Severidade</label>
              <select
                value={test.severity}
                onChange={e => setTest({ ...test, severity: e.target.value })}
                className="w-full mt-1 bg-white/5 border border-white/10 rounded px-2 py-2 text-sm"
              >
                <option value="info">Info</option>
                <option value="warning">Warning</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-white/40">Título</label>
              <input value={test.title} onChange={e => setTest({ ...test, title: e.target.value })}
                className="w-full mt-1 bg-white/5 border border-white/10 rounded px-2 py-2 text-sm text-mono" />
            </div>
            <div>
              <label className="text-xs text-white/40">Mensagem</label>
              <textarea value={test.message} onChange={e => setTest({ ...test, message: e.target.value })}
                rows={3} className="w-full mt-1 bg-white/5 border border-white/10 rounded px-2 py-2 text-sm" />
            </div>
            <button onClick={send} disabled={sending} className="btn btn-primary w-full">
              {sending ? "Enviando…" : "Disparar"}
            </button>
            {/* UX-13: erro em componente dedicado com retry, em vez de JSON cru */}
            {result?.error ? (
              <div className="border border-red/40 rounded p-2.5 space-y-2">
                <p className="text-xs text-red flex items-center gap-1.5">
                  <AlertCircle size={12} aria-hidden="true" /> {result.error}
                </p>
                <button onClick={send} disabled={sending} className="btn w-full text-xs">Tentar novamente</button>
              </div>
            ) : result ? (
              <div className="border border-green/30 rounded p-2.5">
                <p className="text-xs text-green">✓ Alerta de teste disparado</p>
                <pre className="text-[10px] text-mono text-white/50 bg-black/40 p-2 rounded mt-2 overflow-auto max-h-32">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        </div>

        <div className="glass-card p-6 lg:col-span-2">
          <div className="section-title">Regras configuradas</div>
          <div className="space-y-2">
            {(rules || []).map((r: any) => (
              <div key={r.id} className="flex items-center justify-between p-2.5 rounded bg-white/[0.02]">
                <div>
                  <div className="text-sm">{r.name}</div>
                  <div className="text-[10px] text-white/40">canais: {(r.channels || []).join(", ")} · cooldown {r.cooldownMin}min</div>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={r.severity} />
                  <StatusBadge status={r.enabled ? "green" : "muted"} label={r.enabled ? "ON" : "OFF"} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="glass-card p-6">
        <div className="section-title flex items-center gap-2"><AlertCircle size={12} /> Disparos recentes</div>
        <table className="w-full text-xs">
          <thead className="text-white/40 text-[10px] uppercase tracking-widest">
            <tr><th className="text-left py-2">Quando</th><th className="text-left">Severidade</th><th className="text-left">Título</th><th className="text-left">Canais</th><th className="text-center">Enviado</th></tr>
          </thead>
          <tbody>
            {(logs || []).slice(0, 20).map((l: any) => (
              <tr key={l.id} className="border-t border-white/5">
                <td className="py-1.5 text-mono text-white/40">{new Date(l.createdAt).toLocaleString("pt-BR")}</td>
                <td><StatusBadge status={l.severity} /></td>
                <td>{l.title}</td>
                <td className="text-white/60">{(l.channels || []).join(", ")}</td>
                <td className="text-center"><StatusBadge status={l.sent ? "green" : "red"} label={l.sent ? "✓" : "✗"} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
