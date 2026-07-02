"use client";
import { AlertTriangle, RefreshCcw } from "lucide-react";

/** Estado de erro padrão de card (gate UX FASE 4) — mensagem amigável + retry. */
export function CardError({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-md bg-red/5 border border-red/20">
      <AlertTriangle size={16} className="text-red shrink-0" />
      <p className="text-xs text-white/70 flex-1">{message || "Não foi possível carregar os dados."}</p>
      {onRetry && (
        <button onClick={onRetry} className="btn text-xs">
          <RefreshCcw size={12} /> Tentar novamente
        </button>
      )}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <div className="text-center py-8 text-xs text-white/40">{message}</div>;
}
