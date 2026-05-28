"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { setSession } from "@/lib/auth";
import { Activity, ArrowRight, Loader2, ShieldCheck } from "lucide-react";

export default function LoginPage() {
  const router = useRouter();
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    setError(null); setLoading(true);
    try {
      const r: any = await api.requestCode(phone.replace(/\D/g, ""));
      setFirstName(r.firstName || "");
      setStep("code");
    } catch (e: any) {
      setError(e?.message || "Falha ao enviar código");
    } finally {
      setLoading(false);
    }
  };

  const verify = async () => {
    setError(null); setLoading(true);
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
      <div className="fixed inset-0 opacity-30 pointer-events-none" style={{
        backgroundImage: "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
        backgroundSize: "40px 40px"
      }} />

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
                Você receberá um código por WhatsApp.
              </p>
              <label className="text-xs text-white/40 uppercase tracking-wider">Celular</label>
              <input
                value={phone}
                onChange={e => setPhone(e.target.value)}
                placeholder="65 9 8466 5555"
                inputMode="tel"
                className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-2.5 text-mono outline-none focus:border-accent transition"
              />
              {error && <p className="mt-2 text-xs text-red">{error}</p>}
              <button
                onClick={requestCode}
                disabled={loading || phone.length < 10}
                className="btn btn-primary w-full mt-5 py-2.5"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                Enviar código
              </button>
            </>
          )}

          {step === "code" && (
            <>
              <div className="flex items-center gap-2 mb-2">
                <ShieldCheck size={16} className="text-green" />
                <span className="text-xs text-green uppercase tracking-wider">Código enviado</span>
              </div>
              <h1 className="text-2xl font-bold text-display mb-1">Olá, {firstName}</h1>
              <p className="text-sm text-white/50 mb-6">
                Digite o código de 6 dígitos enviado ao seu WhatsApp.
              </p>
              <label className="text-xs text-white/40 uppercase tracking-wider">Código</label>
              <input
                value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                inputMode="numeric"
                className="w-full mt-1 bg-white/5 border border-white/10 rounded-md px-3 py-3 text-center text-3xl text-mono tracking-[0.6em] outline-none focus:border-accent transition"
              />
              {error && <p className="mt-2 text-xs text-red">{error}</p>}
              <button
                onClick={verify}
                disabled={loading || code.length < 6}
                className="btn btn-primary w-full mt-5 py-2.5"
              >
                {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                Entrar
              </button>
              <button onClick={() => setStep("phone")} className="text-xs text-white/40 hover:text-white mt-3 w-full text-center">
                ← Trocar número
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
