"use client";
/**
 * OtpActionButton — ação sensível com re-auth OTP (RBAC no backend).
 * Fluxo: clique → POST /auth/reauth/request (envia OTP via Z-API→Meta/Infobip)
 * → modal pede o código → executa `action(otp)`.
 * Padrão de UX herdado do vault (UX-01/02/04): erros de envio e de código
 * são estados distintos e sempre visíveis.
 */
import { useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Loader2, ShieldCheck, X } from "lucide-react";

interface Props {
  label: string;
  icon?: ReactNode;
  /** Texto de confirmação exibido no modal (o que a ação fará). */
  confirmText: string;
  danger?: boolean;
  className?: string;
  disabled?: boolean;
  action: (otp: string) => Promise<unknown>;
  onDone?: (result: unknown) => void;
}

export function OtpActionButton({ label, icon, confirmText, danger, className, disabled, action, onDone }: Props) {
  const [open, setOpen] = useState(false);
  const [otp, setOtp] = useState("");
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  async function requestOtp() {
    setSent(false);
    setSendError(null);
    setActionError(null);
    try {
      await api.reauthRequest();
      setSent(true);
    } catch (e: any) {
      setSendError(e?.message || "Não foi possível enviar o código. Tente novamente.");
    }
  }

  function openModal() {
    setOpen(true);
    setOtp("");
    void requestOtp();
  }

  async function submit() {
    if (otp.length !== 6 || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await action(otp);
      setOpen(false);
      onDone?.(result);
    } catch (e: any) {
      setActionError(e?.message || "Ação falhou. Verifique o código e tente novamente.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={openModal}
        disabled={disabled}
        className={cn("btn", danger && "border-red/40 text-red hover:bg-red/10", className, disabled && "opacity-40 cursor-not-allowed")}
      >
        {icon}
        {label}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)}>
          <div className="glass-card p-6 w-[360px] space-y-4" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <div className="section-title mb-0 flex items-center gap-2">
                <ShieldCheck size={14} className="text-accent" /> Confirmação OTP
              </div>
              <button onClick={() => setOpen(false)} className="btn-ghost p-1 rounded hover:bg-white/10" aria-label="Fechar">
                <X size={14} />
              </button>
            </div>

            <p className="text-xs text-white/70">{confirmText}</p>

            {sendError ? (
              <div className="space-y-2">
                <p className="text-xs text-red">{sendError}</p>
                <button onClick={() => void requestOtp()} className="btn text-xs">Reenviar código</button>
              </div>
            ) : (
              <p className="text-[11px] text-white/60">
                {sent ? "Código enviado para o seu telefone (WhatsApp/SMS)." : "Enviando código…"}
              </p>
            )}

            <input
              autoFocus
              value={otp}
              onChange={e => setOtp(e.target.value.replace(/\D/g, "").slice(0, 6))}
              onKeyDown={e => e.key === "Enter" && void submit()}
              placeholder="000000"
              inputMode="numeric"
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-2 text-center text-mono text-lg tracking-[0.5em] focus:outline-none focus:border-accent/60"
            />

            {actionError && <p className="text-xs text-red">{actionError}</p>}

            <button
              onClick={() => void submit()}
              disabled={otp.length !== 6 || busy}
              className={cn("btn w-full justify-center", danger ? "border-red/40 text-red hover:bg-red/10" : "btn-primary", (otp.length !== 6 || busy) && "opacity-50")}
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {busy ? "Executando…" : "Confirmar"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
