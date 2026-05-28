"use client";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ITEMS = [
  { href: "/overview", title: "Overview", group: "Navegação", shortcut: "G H" },
  { href: "/srv1", title: "SRV1 Deep Dive", group: "Navegação", shortcut: "G S" },
  { href: "/coolify", title: "Coolify", group: "Navegação", shortcut: "G C" },
  { href: "/hestia", title: "Mail & Sites", group: "Navegação", shortcut: "G M" },
  { href: "/vault", title: "Vault SSM", group: "Navegação", shortcut: "G V" },
  { href: "/apis", title: "APIs", group: "Navegação", shortcut: "G A" },
  { href: "/alerts", title: "Alertas", group: "Navegação", shortcut: "G N" },
  { href: "/analytics", title: "Analytics", group: "Navegação", shortcut: "G T" }
];

export function CommandPalette({ open, onOpenChange }: Props) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
      if (e.key === "Escape") onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[10vh] animate-fade-up"
      onClick={() => onOpenChange(false)}
    >
      <div className="w-full max-w-xl glass-card overflow-hidden" onClick={e => e.stopPropagation()}>
        <Command label="Comando">
          <div className="flex items-center px-4 py-3 border-b border-white/10">
            <Command.Input
              placeholder="Buscar página, container, alerta..."
              className="flex-1 bg-transparent outline-none text-sm placeholder:text-white/30"
              autoFocus
            />
            <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-white/40">ESC</kbd>
          </div>
          <Command.List className="max-h-[400px] overflow-y-auto p-2">
            <Command.Empty className="py-6 text-center text-white/40 text-sm">Nada encontrado.</Command.Empty>
            <Command.Group heading="Navegação">
              {ITEMS.map(it => (
                <Command.Item
                  key={it.href}
                  onSelect={() => { router.push(it.href); onOpenChange(false); }}
                  className="flex items-center justify-between px-3 py-2 rounded-md text-sm text-white/80 cursor-pointer aria-selected:bg-white/10"
                >
                  <span>{it.title}</span>
                  <kbd className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-white/40">{it.shortcut}</kbd>
                </Command.Item>
              ))}
            </Command.Group>
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
