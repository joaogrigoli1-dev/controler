"use client";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { ContainerRow } from "@/lib/schemas";

/**
 * ContainerHeatmap — grid clicável dos containers (Fase 1 §d, /overview).
 * Cor = saúde/estado; intensidade = carga (cpu ou mem). Clique → drill-down.
 */
function tileClass(c: ContainerRow): string {
  const running = c.state === "running" || (c.status ?? "").startsWith("Up");
  if (!running) return "bg-muted/20 border-muted/30 text-white/40";
  if (c.healthcheck === "unhealthy") return "bg-red/20 border-red/50 text-red";
  const load = Math.max(c.cpuPercent ?? 0, c.memPercent ?? 0);
  if (load > 80) return "bg-red/15 border-red/40 text-white/90";
  if (load > 50) return "bg-yellow/15 border-yellow/40 text-white/90";
  return "bg-green/10 border-green/25 text-white/80";
}

export function ContainerHeatmap({ containers, className }: { containers: ContainerRow[]; className?: string }) {
  if (!containers.length) {
    return <div className="text-xs text-white/40 py-6 text-center">Nenhum container reportado.</div>;
  }
  return (
    <div className={cn("grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 xl:grid-cols-8 gap-2", className)}>
      {containers.map(c => (
        <Link
          key={c.name}
          href={`/srv1/containers/${encodeURIComponent(c.name)}`}
          title={`${c.name} · CPU ${c.cpuPercent?.toFixed(1) ?? "—"}% · MEM ${c.memPercent?.toFixed(0) ?? "—"}% · ${c.status ?? c.state ?? ""}`}
          className={cn(
            "rounded-md border px-2 py-2 text-[10px] leading-tight transition-all hover:scale-[1.04] hover:z-10",
            tileClass(c)
          )}
        >
          <div className="truncate font-medium">{c.name}</div>
          <div className="text-mono opacity-70 mt-0.5">
            {c.cpuPercent != null ? `${c.cpuPercent.toFixed(0)}%` : "—"} · {c.memPercent != null ? `${c.memPercent.toFixed(0)}%` : "—"}
          </div>
        </Link>
      ))}
    </div>
  );
}
