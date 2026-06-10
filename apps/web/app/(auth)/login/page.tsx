"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setSession } from "@/lib/auth";
import { Activity, ArrowRight, Loader2, RotateCw, ShieldCheck, Sparkles } from "lucide-react";

const RESEND_COOLDOWN_SEC = 30;

/**
 * UX-20: máscara visual — formata SEM truncar dígitos.
 * Número BR completo = 13 dígitos (55 + DDD + 9XXXXXXXX). Cap em 13 para não cortar o país.
 * Ex.: 5565984665555 -> "55 65 98466 5555"
 */
function formatPhoneDisplay(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 13);
  if (d.length <= 2) return d;                                            // 55
  if (d.length <= 4) return `${d.slice(0, 2)} ${d.slice(2)}`;            // 55 65
  if (d.length <= 9) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;          // 55 65 98466
  return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)} ${d.slice(9)}`;            // 55 65 98466 5555
}

/**
 * Política OTP (29/05/2026): canal ÚNICO Z-API (WhatsApp).
 * SMS e Meta API foram desabilitados para login. Backdoor admin via /be/auth/dev-otp.
 */
export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [loading, setLoading] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [resendNotice, setResendNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (resendCooldown <= 0) return;
    const t = setTimeout(() => setResendCooldown((c: number) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [resendCooldown]);

  const requestCode = async (isResend = false) => {
    setError(null);
    setResendNotice(null);
    setLoading(true);
    try {
      const r: any = await api.requestCode(phone.replace(/\D/g, ""), "whatsapp");
      setFirstName(r.firstName || "");
      setStep("code");
      // UX-12: confirmação visual também no primeiro envio
      setResendNotice(isResend ? "Código reenviado por WhatsApp." : "Código enviado ao WhatsApp ✓");
      if (isResend) setResendCooldown(RESEND_COOLDOWN_SEC);
    } catch (e: any) {
      setError(e?.message || "Falha ao enviar código");
    } finally {
      setLoading(false);
    }
  };

  const resend = async () => {
    if (resendCooldown > 0) return;
    setCode("");
    setError(null);
    await requestCode(true);
  };

  const verify = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await api.verifyCode(phone.replace(/\D/g, ""), code);
      setSession(r.accessToken, r.refreshToken, r.user);
      router.replace("/overview");
    } catch (e: any) {
      setError(e?.message || "Código inválido");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-6 relative">
      {/* Background grid */}
      <div
        className="fixed inset-0 opacity-30 pointer-events-none"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "40px 40px"
        }}
      />
      {/* Glow halo */}
      <div
        className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] pointer-events-none opacity-50"
        style={{
          background:
            "radial-gradient(circle, hsl(248 92% 70% / 0.18) 0%, transparent 60%)"
        }}
      />

      <div className="w-full max-w-sm bezel-card relative z-10">
        <div className="inner">
          <div className="flex items-center gap-3 mb-6">
            <div className="w-12 h-12 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center shadow-glow">
              <Activity size={20} className="text-accent" />
            </div>
            <div>
              <div className="text-display text-xl font-bold tracking-tight">controler</div>
              <div className="text-[10px] text-white/40 uppercase tracking-[0.3em]">noc</div>
            </div>
          </div>

          {step === "phone" && (
            <>
              <h1 className="text-2xl font-bold text-display mb-1">Entrar</h1>
              <p className="text-sm text-white/50 mb-6">
                Você receberá um código de 6 dígitos no <strong className="text-white/80">WhatsApp</strong>.
              </p>
              <label className="text-xs text-white/40 uppercase tracking-wider" htmlFor="phone-input">
                Celular
              </label>
              <input
                id="phone-input"
                value={phone}
                onChange={e => setPhone(formatPhoneDisplay(e.target.value))}
                placeholder="55 65 98466 5555"
                inputMode="tel"
                autoComplete="tel"
                onKeyDown={e => {
                  if (e.key === "Enter" && phone.replace(/\D/g, "").length >= 10) requestCode();
                }}
                className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2.5 text-mono outline-none focus:border-accent transition"
              />
              {error && (
                <p className="mt-2 text-xs text-red" role="alert">
                  {error}
                </p>
              )}
              <button
                onClick={() => requestCode()}
                disabled={loading || phone.replace(/\D/g, "").length < 10}
                className="btn btn-primary w-full mt-5 py-2.5"
                aria-label="Enviar código via WhatsApp"
              >
                {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}
                Enviar código por WhatsApp
              </button>
              <p className="text-[10px] text-white/30 mt-3 text-center flex items-center justify-center gap-1">
                <Sparkles size={9} aria-hidden="true" />
                Entrega via Z-API · sem SMS, sem custo
              </p>
            </>
          )}

          {step === "code" && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck size={16} className="text-green" aria-hidden="true" />
                <span className="text-xs text-green uppercase tracking-wider">Código enviado</span>
              </div>
              <h1 className="text-2xl font-bold text-display mb-1">
                Olá{firstName ? `, ${firstName}` : ""}
              </h1>
              <p className="text-sm text-white/50 mb-6">
                Digite o código de <strong>6 dígitos</strong> recebido no WhatsApp.
              </p>
              <label className="text-xs text-white/40 uppercase tracking-wider" htmlFor="code-input">
                Código
              </label>
              <input
                id="code-input"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={e => {
                  if (e.key === "Enter" && code.length === 6) verify();
                }}
                placeholder="000000"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-3 text-center text-3xl text-mono tracking-[0.6em] outline-none focus:border-accent transition"
              />
              {/* UX-11: feedback do que falta digitar */}
              <p className="mt-1 text-[10px] text-white/30 text-right" aria-hidden="true">{code.length}/6 dígitos</p>
              {error && (
                <p className="mt-2 text-xs text-red" role="alert">
                  {error}
                </p>
              )}
              {resendNotice && <p className="mt-2 text-xs text-green">{resendNotice}</p>}
              <button
                onClick={verify}
                disabled={loading || code.length < 6}
                className="btn btn-primary w-full mt-5 py-2.5"
              >
                {loading ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ArrowRight size={14} aria-hidden="true" />}
                Entrar
              </button>

              <button
                onClick={resend}
                disabled={resendCooldown > 0 || loading}
                className="btn w-full mt-3 py-2 text-xs"
                title="Reenviar via WhatsApp"
              >
                {loading ? <Loader2 size={11} className="animate-spin" aria-hidden="true" /> : <RotateCw size={11} aria-hidden="true" />}
                {resendCooldown > 0 ? `Reenviar em ${resendCooldown}s` : "Reenviar código"}
              </button>

              <button
                onClick={() => {
                  setStep("phone");
                  setCode("");
                  setError(null);
                }}
                className="text-xs text-white/40 hover:text-white mt-3 w-full text-center transition"
              >
                ← Trocar número
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
