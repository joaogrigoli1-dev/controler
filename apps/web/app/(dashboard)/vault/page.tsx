"use client";
import useSWR from "swr";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { toast } from "@/components/ui/Toast";
import { Eye, EyeOff, ShieldAlert, Lock, History, AlertTriangle } from "lucide-react";

export default function VaultPage() {
  // FE-04: error states tratados (antes: falha silenciosa exibindo dados stale)
  const { data: params, error: paramsError } = useSWR("vault", () => api.vaultList(), { refreshInterval: 120000 });
  const { data: audit, error: auditError } = useSWR("vault-audit", () => api.vaultAudit(), { refreshInterval: 60000 });
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [otpModal, setOtpModal] = useState<{ name: string } | null>(null);
  const [otp, setOtp] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpSendError, setOtpSendError] = useState<string | null>(null); // UX-04
  const [otpError, setOtpError] = useState<string | null>(null); // UX-01/UX-02
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [auditExpanded, setAuditExpanded] = useState(false); // UX-10

  // UX-19: fecha o modal com ESC
  useEffect(() => {
    if (!otpModal) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOtpModal(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [otpModal]);

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
    setOtpSendError(null);
    setOtpError(null);
    setOtp("");
    try {
      await api.reauthRequest();
      setOtpSent(true);
    } catch (e: any) {
      // UX-04: falha no envio (Z-API morta, ban etc.) não pode ser silenciosa
      console.error(e);
      setOtpSendError(e?.message || "Não foi possível enviar o código. Tente novamente.");
    }
  };

  const resendCode = async () => {
    setOtpSendError(null);
    setOtpError(null);
    try {
      await api.reauthRequest();
      setOtpSent(true);
      toast.info("Novo código enviado ao WhatsApp");
    } catch (e: any) {
      setOtpSendError(e?.message || "Não foi possível enviar o código. Tente novamente.");
    }
  };

  const doReveal = async () => {
    if (!otpModal || loading) return;
    setLoading(true);
    setOtpError(null);
    try {
      const r: any = await api.vaultReveal(otpModal.name, otp);
      setRevealed(s => ({ ...s, [otpModal.name]: r.value }));
      setOtpModal(null);
      setOtp("");
      toast.success("Credencial revelada ✓"); // UX-05
    } catch (e: any) {
      // UX-01/UX-02: erro inline no modal em vez de alert()
      setOtpError(e?.message || "Código inválido ou expirado. Tente novamente.");
      setOtp("");
    } finally {
      setLoading(false);
    }
  };

  const auditRows = auditExpanded ? (audit || []) : (audit || []).slice(0, 12);

  return (
    <div className="space-y-6 animate-fade-up">
      <div className="glass-card p-4 flex items-center gap-3 border-l-2 border-yellow">
        <ShieldAlert size={16} className="text-yellow" />
        <p className="text-xs text-white/70">
          Valores são mascarados por padrão — clique no olho para revelar com <b>OTP WhatsApp</b>.
          Toda revelação fica registrada no audit log abaixo.
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

      {paramsError && (
        <div className="glass-card p-4 flex items-center gap-3 border-l-2 border-red">
          <AlertTriangle size={16} className="text-red" />
          <p className="text-xs text-white/70 flex-1">Erro ao carregar parâmetros: {paramsError.message}</p>
          <button onClick={() => location.reload()} className="btn">Tentar novamente</button>
        </div>
      )}

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
                    aria-label={visible ? `Ocultar valor de ${p.key}` : `Revelar valor de ${p.key} (requer OTP)`}
                    title={visible ? "Ocultar valor" : "Revelar valor (envia código OTP por WhatsApp)"}
                  >
                    {visible ? <EyeOff size={11} aria-hidden="true" /> : <Eye size={11} aria-hidden="true" />}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ))}

      <div className="glass-card p-6">
        <div className="section-title flex items-center gap-2"><History size={12} /> Audit log</div>
        {auditError ? (
          <p className="text-xs text-red py-2">Erro ao carregar o audit log: {auditError.message}</p>
        ) : (
          <>
            <table className="w-full text-xs">
              <thead className="text-white/40 text-[10px] uppercase tracking-widest">
                <tr><th className="text-left py-2">Quando</th><th className="text-left">Usuário</th><th className="text-left">Ação</th><th className="text-left">Recurso</th><th className="text-left">IP</th></tr>
              </thead>
              <tbody>
                {auditRows.map((a: any) => (
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
            {/* UX-10: indica quantos eventos existem e permite expandir */}
            {(audit?.length ?? 0) > 12 && (
              <button onClick={() => setAuditExpanded(v => !v)} className="btn mt-3 text-xs">
                {auditExpanded ? "Mostrar menos" : `Mostrando 12 de ${audit.length} eventos — ver todos`}
              </button>
            )}
          </>
        )}
      </div>

      {otpModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur z-50 flex items-center justify-center"
          onClick={() => setOtpModal(null)}
          role="dialog"
          aria-modal="true"
          aria-label={`Revelar credencial ${otpModal.name}`}
        >
          <div className="bezel-card max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="inner">
              <h3 className="text-display font-bold text-lg mb-1">Revelar credencial</h3>
              <p className="text-xs text-white/50 mb-4 text-mono">{otpModal.name}</p>
              {otpSendError ? (
                <div className="mb-4">
                  <p className="text-sm text-red mb-2">{otpSendError}</p>
                  <button onClick={resendCode} className="btn w-full">Reenviar código</button>
                </div>
              ) : (
                <p className="text-sm text-white/70 mb-4">
                  {otpSent ? "Código enviado ao WhatsApp. Digite abaixo." : "Enviando código…"}
                </p>
              )}
              <input
                value={otp}
                onChange={e => { setOtp(e.target.value.replace(/\D/g, "").slice(0, 6)); setOtpError(null); }}
                onKeyDown={e => { if (e.key === "Enter" && otp.length === 6 && !loading) doReveal(); }}
                placeholder="000000"
                inputMode="numeric"
                aria-label="Código OTP de 6 dígitos"
                className={`w-full bg-white/5 border rounded-md px-3 py-2.5 text-center text-2xl text-mono tracking-[0.5em] outline-none focus:border-accent ${otpError ? "border-red/60" : "border-white/10"}`}
                autoFocus
              />
              {/* UX-01/UX-02: erro inline + contador de dígitos (UX-11) */}
              <div className="flex items-center justify-between mt-2 min-h-[18px]">
                {otpError
                  ? <span className="text-xs text-red">{otpError}</span>
                  : <span className="text-xs text-white/30">{otp.length}/6 dígitos</span>}
                {otpError && <button onClick={resendCode} className="text-xs text-cyan hover:underline">Reenviar código</button>}
              </div>
              <div className="flex gap-2 mt-4">
                <button onClick={() => setOtpModal(null)} className="btn flex-1">Cancelar</button>
                <button onClick={doReveal} disabled={otp.length !== 6 || loading} className="btn btn-primary flex-1">
                  {loading ? "Validando…" : "Revelar"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
