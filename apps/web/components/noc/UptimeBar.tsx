import { cn } from "@/lib/utils";
import type { Rag } from "@/lib/schemas";

export interface UptimeSegment {
  label?: string;
  status: Rag | "nodata";
}

const SEG_CLASS: Record<UptimeSegment["status"], string> = {
  ok: "bg-green/80",
  warn: "bg-yellow/80",
  crit: "bg-red/80",
  stale: "bg-muted/50",
  nodata: "bg-white/[0.06]"
};

/**
 * UptimeBar — barra de disponibilidade estilo status-page (Fase 1 §d, /apis e /analytics).
 * "Sem dado" é 3º estado, nunca conta como up nem down.
 */
export function UptimeBar({ segments, className }: { segments: UptimeSegment[]; className?: string }) {
  return (
    <div className={cn("flex items-stretch gap-[3px] h-6 w-full", className)} role="img" aria-label="Barra de disponibilidade">
      {segments.map((s, i) => (
        <div
          key={i}
          title={s.label ?? s.status}
          className={cn("flex-1 rounded-[3px] min-w-[3px] transition-opacity hover:opacity-70", SEG_CLASS[s.status])}
        />
      ))}
    </div>
  );
}
