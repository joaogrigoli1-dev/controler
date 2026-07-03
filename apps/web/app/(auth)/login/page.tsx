"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setSession } from "@/lib/auth";
import { Activity, ArrowRight, Loader2, RotateCw, MessageCircle, ServerCog, BellRing, ShieldCheck } from "lucide-react";

const RESEND_COOLDOWN_SEC = 30;

/**
 * Máscara visual — formata SEM truncar dígitos. Número BR completo = 13 dígitos
 * (55 + DDD + 9XXXXXXXX). Ex.: 5565984665555 -> "55 65 98466 5555".
 * O backend tolera o número com ou sem o DDI 55.
 */
function formatPhoneDisplay(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 13);
  if (d.length <= 2) return d;
  if (d.length <= 4) return `${d.slice(0, 2)} ${d.slice(2)}`;
  if (d.length <= 9) return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 9)} ${d.slice(9)}`;
}

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
      setResendNotice(isResend ? "Código reenviado por WhatsApp." : "Código enviado ao seu WhatsApp.");
      if (isResend) setResendCooldown(RESEND_COOLDOWN_SEC);
    } catch (e: any) {
      setError(e?.message || "Não foi possível enviar o código. Tente novamente.");
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
      setSession(r.accessToken, r.user);
      router.replace("/overview");
    } catch (e: any) {
      setError(e?.message || "Código inválido ou expirado.");
    } finally {
      setLoading(false);
    }
  };

  const phoneReady = phone.replace(/\D/g, "").length >= 10;

  return (
    <div className="min-h-screen grid lg:grid-cols-[1.1fr_1fr]">
      {/* ── Painel de marca (só desktop) ── */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden p-12 xl:p-16 border-r border-white/5">
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              "radial-gradient(120% 90% at 15% 0%, hsl(var(--accent) / 0.14), transparent 55%), radial-gradient(90% 80% at 100% 100%, hsl(var(--purple) / 0.16), transparent 55%)"
          }}
        />
        <div className="relative z-10 flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shadow-glow">
            <Activity size={22} className="text-accent" />
          </div>
          <div>
            <div className="text-display text-lg font-bold tracking-tight leading-none">controler</div>
            <div className="text-[10px] text-white/40 uppercase tracking-[0.35em] mt-1">network operations center</div>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <h2 className="text-display text-3xl xl:text-4xl font-bold leading-tight">
            Sua infraestrutura,<br />sob controle.
          </h2>
          <p className="text-white/55 mt-4 leading-relaxed">
            Visão unificada do SRV1 — hosts, containers e deploys monitorados em tempo real,
            com alertas inteligentes e acesso seguro.
          </p>
          <ul className="mt-8 space-y-3">
            {[
              { icon: ServerCog, t: "Monitoramento em tempo real de host e containers" },
              { icon: BellRing, t: "Alertas de saturação, deploys e disponibilidade" },
              { icon: ShieldCheck, t: "Acesso protegido por código de uso único" }
            ].map(({ icon: Icon, t }, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-white/70">
                <span className="mt-0.5 w-7 h-7 shrink-0 rounded-lg bg-white/[0.04] border border-white/10 flex items-center justify-center">
                  <Icon size={14} className="text-accent" />
                </span>
                <span className="leading-relaxed">{t}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="relative z-10 flex items-center gap-2 text-[11px] text-white/30">
          <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
          v4.0.0 · noc.controler.net.br
        </div>
      </aside>

      {/* ── Formulário ── */}
      <main className="relative flex items-center justify-center p-6 sm:p-10">
        <div
          className="absolute inset-0 pointer-events-none lg:hidden opacity-60"
          style={{ background: "radial-gradient(90% 60% at 50% 0%, hsl(var(--accent) / 0.12), transparent 60%)" }}
        />
        <div className="relative z-10 w-full max-w-[380px]">
          {/* Logo compacto (só mobile, já que o painel some) */}
          <div className="flex lg:hidden items-center gap-2.5 mb-8">
            <div className="w-10 h-10 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center shadow-glow">
              <Activity size={18} className="text-accent" />
            </div>
            <div className="text-display text-base font-bold tracking-tight">
              controler <span className="text-white/40 font-normal text-xs uppercase tracking-widest">noc</span>
            </div>
          </div>

          {step === "phone" && (
            <div className="animate-[fadeIn_.2s_ease]">
              <h1 className="text-display text-[26px] font-bold leading-tight">Acessar o painel</h1>
              <p className="text-sm text-white/55 mt-2 mb-7">
                Informe seu celular. Enviaremos um código de verificação pelo WhatsApp.
              </p>

              <label className="text-xs font-medium text-white/70" htmlFor="phone-input">Celular</label>
              <input
                id="phone-input"
                value={phone}
                onChange={e => setPhone(formatPhoneDisplay(e.target.value))}
                placeholder="55 65 98466 5555"
                inputMode="tel"
                autoComplete="tel"
                autoFocus
                onKeyDown={e => { if (e.key === "Enter" && phoneReady) requestCode(); }}
                className="w-full mt-1.5 bg-white/[0.04] border border-white/12 rounded-lg px-3.5 py-3 text-mono text-[15px] outline-none focus:border-accent focus:bg-white/[0.06] transition"
              />

              {error && <p className="mt-2.5 text-xs text-red" role="alert">{error}</p>}

              <button
                onClick={() => requestCode()}
                disabled={loading || !phoneReady}
                className="btn btn-primary w-full mt-6 py-3 text-sm font-semibold"
                aria-label="Enviar código por WhatsApp"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                Enviar código
              </button>

              <p className="mt-5 flex items-center justify-center gap-1.5 text-[11px] text-white/35">
                <MessageCircle size={11} className="text-accent/70" />
                Entrega via WhatsApp · sem custo
              </p>
            </div>
          )}

          {step === "code" && (
            <div className="animate-[fadeIn_.2s_ease]">
              <h1 className="text-display text-[26px] font-bold leading-tight">
                {firstName ? `Olá, ${firstName}` : "Verificação"}
              </h1>
              <p className="text-sm text-white/55 mt-2 mb-7">
                Digite o código de 6 dígitos enviado para{" "}
                <span className="text-white/80 text-mono whitespace-nowrap">{formatPhoneDisplay(phone) || "seu WhatsApp"}</span>.
              </p>

              <label className="text-xs font-medium text-white/70" htmlFor="code-input">Código de verificação</label>
              <input
                id="code-input"
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                onKeyDown={e => { if (e.key === "Enter" && code.length === 6) verify(); }}
                placeholder="——————"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                className="w-full mt-1.5 bg-white/[0.04] border border-white/12 rounded-lg px-3 py-3.5 text-center text-[30px] text-mono tracking-[0.5em] outline-none focus:border-accent focus:bg-white/[0.06] transition"
              />

              {error && <p className="mt-2.5 text-xs text-red" role="alert">{error}</p>}
              {!error && resendNotice && (
                <p className="mt-2.5 flex items-center gap-1.5 text-xs text-green">
                  <ShieldCheck size={13} /> {resendNotice}
                </p>
              )}

              <button
                onClick={verify}
                disabled={loading || code.length < 6}
                className="btn btn-primary w-full mt-6 py-3 text-sm font-semibold"
              >
                {loading ? <Loader2 size={15} className="animate-spin" /> : <ArrowRight size={15} />}
                Entrar
              </button>

              <div className="mt-5 flex items-center justify-between text-xs">
                <button
                  onClick={() => { setStep("phone"); setCode(""); setError(null); }}
                  className="text-white/45 hover:text-white/80 transition"
                >
                  ← Trocar número
                </button>
                <button
                  onClick={resend}
                  disabled={resendCooldown > 0 || loading}
                  className="inline-flex items-center gap-1.5 text-accent/90 hover:text-accent disabled:text-white/30 disabled:cursor-not-allowed transition"
                >
                  <RotateCw size={12} className={loading ? "animate-spin" : ""} />
                  {resendCooldown > 0 ? `Reenviar em ${resendCooldown}s` : "Reenviar código"}
                </button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
