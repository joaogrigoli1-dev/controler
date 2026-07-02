import { cn } from "@/lib/utils";
import type { Rag } from "@/lib/schemas";

/**
 * RagBadge — semáforo RAG da Fase 1 (§d, semântica de cor fixa).
 * ok=teal/green · warn=âmbar · crit=vermelho · stale=cinza (nunca fingir verde).
 * Cor nunca é canal único: sempre dot + label.
 */
const MAP: Record<Rag, { badge: string; dot: string; text: string }> = {
  ok: { badge: "badge-green", dot: "bg-green", text: "OK" },
  warn: { badge: "badge-yellow", dot: "bg-yellow", text: "WARN" },
  crit: { badge: "badge-red", dot: "bg-red", text: "CRIT" },
  stale: { badge: "badge-muted", dot: "bg-muted", text: "STALE" }
};

export function RagBadge({ rag, label, pulse }: { rag: Rag; label?: string; pulse?: boolean }) {
  const m = MAP[rag];
  return (
    <span className={cn("badge", m.badge)}>
      <span className={cn("inline-block w-1.5 h-1.5 rounded-full", m.dot, pulse && rag === "crit" && "animate-pulse")} />
      {label ?? m.text}
    </span>
  );
}

/** Classe de dot estática por RAG (JIT-safe, mesmo racional do B-01). */
export function ragDotClass(rag: Rag): string {
  return MAP[rag].dot;
}

/** Classe de texto estática por RAG. */
export function ragTextClass(rag: Rag): string {
  switch (rag) {
    case "ok": return "text-green";
    case "warn": return "text-yellow";
    case "crit": return "text-red";
    default: return "text-muted";
  }
}
