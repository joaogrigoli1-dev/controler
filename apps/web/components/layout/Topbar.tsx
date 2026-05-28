"use client";
import { usePathname } from "next/navigation";
import { Bell, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { getSocket } from "@/lib/socket";

function pageTitle(path: string) {
  if (path.startsWith("/overview")) return "Mission Control";
  if (path.startsWith("/srv1")) return "SRV1 — Deep Dive";
  if (path.startsWith("/coolify")) return "Coolify Apps";
  if (path.startsWith("/hestia")) return "Mail & Sites";
  if (path.startsWith("/vault")) return "Vault SSM";
  if (path.startsWith("/apis")) return "APIs por Projeto";
  if (path.startsWith("/alerts")) return "Alert Center";
  if (path.startsWith("/analytics")) return "Analytics";
  return "Controler";
}

export function Topbar() {
  const path = usePathname() || "";
  const [connected, setConnected] = useState(false);
  const [now, setNow] = useState<string>(new Date().toLocaleTimeString("pt-BR"));

  useEffect(() => {
    const s = getSocket();
    const onConn = () => setConnected(true);
    const onDisc = () => setConnected(false);
    s.on("connect", onConn);
    s.on("disconnect", onDisc);
    if (s.connected) onConn();
    const t = setInterval(() => setNow(new Date().toLocaleTimeString("pt-BR")), 1000);
    return () => { s.off("connect", onConn); s.off("disconnect", onDisc); clearInterval(t); };
  }, []);

  return (
    <header
      className="fixed top-0 right-0 bg-surface-0/60 backdrop-blur-xl border-b border-white/5 flex items-center justify-between px-6 z-40 scanline"
      style={{ left: "var(--sidebar-w)", height: "var(--topbar-h)" }}
    >
      <div className="flex items-center gap-4">
        <h1 className="text-display text-lg font-semibold tracking-tight">{pageTitle(path)}</h1>
        <span className="badge badge-cyan">
          <span className="pulse-dot" style={{ background: "currentColor" }} />
          LIVE
        </span>
      </div>
      <div className="flex items-center gap-3 text-xs">
        <div className={`badge ${connected ? "badge-green" : "badge-red"}`}>
          {connected ? "● WS conectado" : "○ Reconectando..."}
        </div>
        <span className="text-mono text-white/40">{now}</span>
        <button className="btn btn-ghost" onClick={() => location.reload()}>
          <RefreshCw size={12} />
        </button>
        <button className="btn btn-ghost relative">
          <Bell size={12} />
        </button>
      </div>
    </header>
  );
}
