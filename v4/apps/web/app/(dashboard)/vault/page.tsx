"use client";
import useSWR from "swr";
import { useState } from "react";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Eye, EyeOff, ShieldAlert, Lock, History } from "lucide-react";

export default function VaultPage() {
  const { data: params } = useSWR("vault", () => api.vaultList(), { refreshInterval: 120000 });
  const { data: audit } = useSWR("vault-audit", () => api.vaultAudit(), { refreshInterval: 60000 });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [otpModal, setOtpModal] = useState<{ name: string } | null>(null);
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  const grouped: Record<string, any[]> = {};
  (params || [])
    .filter((p: any) => !filter || p.name.toLowerCase().includes(filter.toLowerCase()))
    .forEach((p: any) => {
      const k = p.project || "root";
      if (!grouped[k]) grouped[k] = [];
      grouped[k].push(p);
    });

  const requestReauthAndReveal = async (name: string) => {
    setOtpModal({ name });
    setOtpSent(false);
    setOtp("");
    try { await api.reauthRequest(); setOtpSent(true); } catch (e) { console.error(e); }
  };

  const doReveal = async () => {
    if (!otpModal) return;
    setLoading(true);
    try {
      const r: any = await api.vaultReveal(otpModal.name, otp);
      setRevealed(s => ({ ...s, [otpModal.name]: r.value }));
      setOtpModal(null);
      setOtp("");
    } catch (e: any) {
      alert(e?.message || "OTP inválido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="glass-card p-4 flex items-center gap-3 border-l-2 border-yellow">
        <ShieldAlert size={16} className="text-yellow" />
        <p className="text-xs text-white/70">
          Toda revelação exige <b>OTP WhatsApp</b> e fica registrada no audit log abaixo.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filtrar por nome do parâmetro..."
          className="flex-1 bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-mono outline-none focus:border-accent"
        />
        <span className="text-xs text-white/40">{params?.length ?? 0} parâmetros</span>
      </div>

      {Object.entries(grouped).map(([prj, items]) => (
        <div key={prj} className="glass-card p-6">
          <div className="section-title flex items-center gap-2"><Lock size={12} /> /{prj} ({items.length})</div>
          <div className="space-y-1 text-xs">
            {items.map((p: any) => {
              const visible = !!revealed[p.name];
              return (
                <div key={p.name} className="flex items-center gap-3 p-2 rounded hover:bg-white/[0.02]">
                  <span className="text-mono text-cyan flex-1 truncate">{p.key}</span>
                  <StatusBadge status={p.type === "SecureString" ? "purple" : "muted"} label={p.type} />
                  <span className="text-mono text-white/50 w-[200px] text-right truncate">
                    {visible ? revealed[p.name] : "••••••••"}
                  </span>
                  <button
                    onClick={() => visible ? setRevealed(s => { const x = { ...s }; delete x[p.name]; return x; }) : requestReauthAndReveal(p.name)}
                    className="btn"
                  >
                    {visible ? <EyeOff size={11} /> : <Eye size={11} />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="glass-card p-6">
        <div className="section-title flex items-center gap-2"><History size={12} /> Audit log</div>
        <table className="w-full text-xs">
          <thead className="text-white/40 text-[10px] uppercase tracking-widest">
            <tr><th className="text-left py-2">Quando</th><th className="text-left">Usuário</th><th className="text-left">Ação</th><th className="text-left">Recurso</th><th className="text-left">IP</th></tr>
          </thead>
          <tbody>
            {(audit || []).slice(0, 12).map((a: any) => (
              <tr key={a.id} className="border-t border-white/5">
                <td className="py-1.5 text-mono text-white/40">{new Date(a.createdAt).toLocaleString("pt-BR")}</td>
                <td>{a.user?.name || "—"}</td>
                <td><StatusBadge status="cyan" label={a.action} /></td>
                <td className="text-mono text-white/70">{a.resource}</td>
                <td className="text-mono text-white/40">{a.ipAddress}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {otpModal && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur z-50 flex items-center justify-center" onClick={() => setOtpModal(null)}>
          <div className="bezel-card max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="inner">
              <h3 className="text-display font-bold text-lg mb-1">Revelar credencial</h3>
              <p className="text-xs text-white/50 mb-4 text-mono">{otpModal.name}</p>
              <p className="text-sm text-white/70 mb-4">
                {otpSent ? "Código enviado ao WhatsApp. Digite abaixo." : "Enviando código…"}
              </p>
              <input
                value={otp}
                onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2.5 text-center text-2xl text-mono tracking-[0.5em] outline-none focus:border-accent"
                autoFocus
              />
              <div className="flex gap-2 mt-4">
                <button onClick={() => setOtpModal(null)} className="btn flex-1">Cancelar</button>
                <button onClick={doReveal} disabled={otp.length !== 6 || loading} className="btn btn-primary flex-1">
                  {loading ? "…" : "Revelar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
