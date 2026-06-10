"use client";
/**
 * Toast minimalista (UX-01/UX-05/UX-13) — sem dependências.
 * Uso: toast.success("Credencial revelada"); toast.error("Falha ao enviar código");
 * Monte <Toaster /> uma vez no layout do dashboard.
 */
import { useEffect, useState } from "react";

type ToastType = "success" | "error" | "info";
interface ToastItem { id: number; type: ToastType; message: string }

type Listener = (t: ToastItem) => void;
let listeners: Listener[] = [];
let nextId = 1;

function push(type: ToastType, message: string) {
  const item: ToastItem = { id: nextId++, type, message };
  listeners.forEach(l => l(item));
}

export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
  info: (m: string) => push("info", m)
};

const COLORS: Record<ToastType, string> = {
  success: "border-green/40 text-green",
  error: "border-red/40 text-red",
  info: "border-cyan/40 text-cyan"
};
const ICONS: Record<ToastType, string> = { success: "✓", error: "✕", info: "ℹ" };

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const l: Listener = item => {
      setItems(s => [...s, item]);
      setTimeout(() => setItems(s => s.filter(i => i.id !== item.id)), 4500);
    };
    listeners.push(l);
    return () => { listeners = listeners.filter(x => x !== l); };
  }, []);

  if (items.length === 0) return null;
  return (
    <div className="fixed bottom-6 right-6 z-[100] flex flex-col gap-2" role="status" aria-live="polite">
      {items.map(i => (
        <div
          key={i.id}
          className={`glass-card px-4 py-3 text-sm flex items-center gap-3 border ${COLORS[i.type]} shadow-lg animate-fade-up max-w-sm`}
        >
          <span aria-hidden="true">{ICONS[i.type]}</span>
          <span className="text-white/90">{i.message}</span>
          <button
            onClick={() => setItems(s => s.filter(x => x.id !== i.id))}
            className="ml-auto text-white/40 hover:text-white/80"
            aria-label="Fechar notificação"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
