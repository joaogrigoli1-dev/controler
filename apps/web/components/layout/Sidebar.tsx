"use client";
import Link from "next/link";
import { useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { clearSession } from "@/lib/auth";
import { disposeSocket } from "@/lib/socket";
import {
  LayoutGrid, Server, Boxes, Globe, KeyRound, Plug, Bell, BarChart3,
  Search, LogOut, Activity
} from "lucide-react";

const NAV = [
  { href: "/overview", label: "Overview", icon: LayoutGrid, hint: "G H" },
  { href: "/srv1", label: "SRV1", icon: Server, hint: "G S" },
  { href: "/srv1/containers", label: "Containers", icon: Boxes, hint: "G B" },
  { href: "/coolify", label: "Coolify", icon: Boxes, hint: "G C" },
  { href: "/hestia", label: "Mail & Sites", icon: Globe, hint: "G M" },
  { href: "/vault", label: "Vault", icon: KeyRound, hint: "G V" },
  { href: "/apis", label: "APIs", icon: Plug, hint: "G A" },
  { href: "/alerts", label: "Alertas", icon: Bell, hint: "G N" },
  { href: "/analytics", label: "Analytics", icon: BarChart3, hint: "G T" }
];

export function Sidebar({ onCmdK }: { onCmdK: () => void }) {
  const path = usePathname() || "";
  const [logoutModal, setLogoutModal] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // UX-09/FE-16: logout com modal custom; revoga a sessão no backend, remove apenas
  // as chaves controler:* (não localStorage.clear()) e força reload completo
  // (limpa o cache em memória do SWR).
  const doLogout = async () => {
    setLoggingOut(true);
    try { await api.logout(); } catch { /* sessão já pode estar expirada — segue o logout local */ }
    disposeSocket();
    clearSession();
    location.href = "/login";
  };

  return (
    <aside
      className="noc-sidebar fixed top-0 left-0 h-full flex flex-col z-40"
      style={{ width: "var(--sidebar-w)" }}
      aria-label="Navegação principal"
    >
      <div className="p-5 border-b border-white/5 flex items-center justify-between">
        <Link href="/overview" className="flex items-center gap-2.5 group">
          <div className="w-8 h-8 rounded-md bg-accent/20 border border-accent/30 flex items-center justify-center group-hover:bg-accent/30 transition">
            <Activity size={16} className="text-accent" />
          </div>
          <div>
            <div className="text-display font-bold text-sm tracking-tight">controler</div>
            <div className="text-[9px] text-white/40 uppercase tracking-[0.2em]">noc</div>
          </div>
        </Link>
      </div>

      <button
        onClick={onCmdK}
        className="mx-3 mt-3 flex items-center gap-2 px-3 py-2 rounded-md text-xs text-white/40 bg-white/[0.03] border border-white/5 hover:bg-white/5 transition"
      >
        <Search size={12} />
        <span className="flex-1 text-left">Buscar...</span>
        <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-white/50">⌘K</kbd>
      </button>

      <nav className="flex-1 px-2 py-4 space-y-0.5 overflow-y-auto" aria-label="Telas do dashboard">
        {NAV.map(({ href, label, icon: Icon, hint }) => {
          // "/srv1" não pode acender junto com "/srv1/containers" (prefixo comum)
          const isActive = href === "/srv1" ? path === "/srv1" : path.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn("nav-link", isActive && "active")}
              aria-current={isActive ? "page" : undefined}
              title={`${label} (atalho: ${hint})`}
            >
              <Icon size={15} aria-hidden="true" />
              <span className="flex-1">{label}</span>
              <span className="text-[9px] text-white/50 font-mono" aria-hidden="true">{hint}</span>
            </Link>
          );
        })}
      </nav>

      <div className="p-3 border-t border-white/5">
        <button
          onClick={() => setLogoutModal(true)}
          className="nav-link w-full text-white/60 hover:text-red"
          aria-label="Sair do sistema"
          title="Sair (vai pedir confirmação)"
        >
          <LogOut size={14} aria-hidden="true" />
          <span>Sair</span>
        </button>
      </div>

      {logoutModal && (
        <div
          className="fixed inset-0 bg-black/70 backdrop-blur z-50 flex items-center justify-center"
          onClick={() => !loggingOut && setLogoutModal(false)}
          onKeyDown={e => { if (e.key === "Escape" && !loggingOut) setLogoutModal(false); }}
          role="dialog"
          aria-modal="true"
          aria-label="Confirmar saída"
        >
          <div className="bezel-card max-w-xs" onClick={e => e.stopPropagation()}>
            <div className="inner">
              <h3 className="text-display font-bold text-lg mb-2">Sair do Controler?</h3>
              <p className="text-xs text-white/70 mb-4">Sua sessão será encerrada neste dispositivo.</p>
              <div className="flex gap-2">
                <button onClick={() => setLogoutModal(false)} disabled={loggingOut} className="btn flex-1" autoFocus>
                  Cancelar
                </button>
                <button onClick={doLogout} disabled={loggingOut} className="btn flex-1 text-red border-red/40 hover:bg-red/10">
                  {loggingOut ? "Saindo…" : "Sair"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
