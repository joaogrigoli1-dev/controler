"use client";
import { usePathname } from "next/navigation";
import { Bell, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { mutate } from "swr";
import { getSocket } from "@/lib/socket";

// UX-15: o mesmo fuso no SSR e no navegador evita divergência de hidratação.
const TZ_LABEL = "UTC−4";
const CUIABA_TIME = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Cuiaba",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false
});

function pageTitle(path: string) {
  if (path.startsWith("/overview")) return "Mission Control";
  if (path.startsWith("/srv1")) return "SRV1 — Deep Dive";
  if (path.startsWith("/coolify")) return "Coolify Apps";
  if (path.startsWith("/hestia")) return "Mail & Sites";
  if (path.startsWith("/vault")) return "Vault SSM";
  if (path.startsWith("/apis")) return "APIs por Projeto";
  if (path.startsWith("/sinc")) return "Sinc";
  if (path.startsWith("/roteador")) return "Roteador";
  if (path.startsWith("/alerts")) return "Alert Center";
  if (path.startsWith("/analytics")) return "Analytics";
  return "Controler";
}

export function Topbar() {
  const path = usePathname() || "";
  const tahoeRoute = path.startsWith("/sinc") || path.startsWith("/roteador");
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState<string>("--:--:--");

  useEffect(() => {
    setNow(CUIABA_TIME.format(new Date()));
    const s = getSocket();
    let wasDisconnected = false;
    const onConn = () => {
      setConnected(true);
      // UX-14: ao reconectar, revalida todas as queries SWR (dados podem estar stale)
      if (wasDisconnected) {
        wasDisconnected = false;
        mutate(() => true);
      }
    };
    const onDisc = () => { wasDisconnected = true; setConnected(false); };
    s.on("connect", onConn);
    s.on("disconnect", onDisc);
    if (s.connected) onConn();
    const t = setInterval(() => setNow(CUIABA_TIME.format(new Date())), 1000);
    return () => { s.off("connect", onConn); s.off("disconnect", onDisc); clearInterval(t); };
  }, []);

  return (
    <header
      className="noc-topbar fixed top-0 right-0 bg-surface-0/60 backdrop-blur-xl border-b border-white/5 flex items-center justify-between px-6 z-40 scanline"
      style={{ left: "var(--sidebar-w)", height: "var(--topbar-h)" }}
    >
      <div className="flex items-center gap-4">
        <h1 className="text-display text-lg font-semibold tracking-tight">{pageTitle(path)}</h1>
        <span className="badge badge-cyan">
          {!tahoeRoute && <span className="pulse-dot" style={{ background: "currentColor" }} />}
          {tahoeRoute ? "INFORMATIVO" : "LIVE"}
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        {/* UX-14: deixa explícito que os dados podem estar desatualizados */}
        {!connected && (
          <span className="noc-realtime-status badge badge-yellow" title="Sem conexão em tempo real — os valores exibidos podem estar desatualizados">
            ⚠ Dados podem estar desatualizados
          </span>
        )}
        <div
          className={`noc-realtime-status badge ${connected ? "badge-green" : "badge-red"}`}
          title={connected ? "WebSocket conectado — métricas em tempo real" : "Tentando reconectar ao servidor de métricas"}
        >
          {connected ? "● WS conectado" : "○ Reconectando..."}
        </div>
        <span
          className="text-mono text-white/70 hidden sm:inline"
          aria-label={`Hora atual: ${now} (${TZ_LABEL})`}
          title={`Horário operacional (${TZ_LABEL}). Logs e alertas do servidor usam America/Cuiaba.`}
        >
          {now} <span className="text-white/40">{TZ_LABEL}</span>
        </span>
        <button
          className="btn btn-ghost"
          onClick={() => location.reload()}
          aria-label="Recarregar página"
          title="Recarregar página"
        >
          <RefreshCw size={12} aria-hidden="true" />
        </button>
        <button
          className="btn btn-ghost relative"
          aria-label="Notificações"
          title="Notificações (em breve)"
        >
          <Bell size={12} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
