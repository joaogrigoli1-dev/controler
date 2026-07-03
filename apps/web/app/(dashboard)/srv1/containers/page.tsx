"use client";
/**
 * /srv1/containers — grade dos containers do SRV1 (FASE 4).
 * Dados reais de /srv1/containers (nocFetch + Zod) com refresh 30s e
 * atualização em tempo real via socket "container:metrics".
 * Ordenação: unhealthy primeiro, depois CPU desc. Card → drill-down.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { nocFetch, useNoc } from "@/lib/noc";
import { ContainerListSchema, THRESHOLDS, ragOf, type ContainerRow } from "@/lib/schemas";
import { useSocketEvent } from "@/lib/socket";
import { KpiTile } from "@/components/ui/KpiTile";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { DataBadge } from "@/components/noc/DataBadge";
import { CardError } from "@/components/noc/CardError";
import { EmptyState } from "@/components/noc/CardError";
import { Skeleton } from "@/components/noc/Skeleton";
import { ragDotClass } from "@/components/noc/RagBadge";
import { cn, fmtPct } from "@/lib/utils";
import { Boxes, PlayCircle, HeartPulse, AlertTriangle, RotateCcw, Search, Clock } from "lucide-react";

type StateFilter = "todos" | "running" | "exited" | "unhealthy";

const FILTERS: Array<{ id: StateFilter; label: string }> = [
  { id: "todos", label: "Todos" },
  { id: "running", label: "Running" },
  { id: "exited", label: "Exited" },
  { id: "unhealthy", label: "Unhealthy" }
];

function isRunning(c: ContainerRow): boolean {
  return c.state === "running" || Boolean(c.status?.startsWith("Up"));
}

function isUnhealthy(c: ContainerRow): boolean {
  return c.healthcheck === "unhealthy";
}

/** Barra fina de uso (cpu/mem) com cor RAG estática (JIT-safe). */
function UsageBar({ label, value, warn, crit }: { label: string; value: number | null | undefined; warn: number; crit: number }) {
  const rag = ragOf(value, warn, crit);
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-white/60">
        <span className="uppercase tracking-widest">{label}</span>
        <span className="text-mono text-white/70">{fmtPct(value ?? null)}</span>
      </div>
      <div className="h-1 mt-1 rounded-full bg-white/[0.06] overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all", ragDotClass(rag))}
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      </div>
    </div>
  );
}

export default function ContainersPage() {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<StateFilter>("todos");

  const list = useNoc(
    "containers-grid",
    () => nocFetch("/srv1/containers", ContainerListSchema),
    30_000
  );

  // Tempo real: o gateway emite "container:metrics" — usa se o payload trouxer a lista.
  const live = useSocketEvent<{ containers?: ContainerRow[] }>("container:metrics");
  const containers: ContainerRow[] = useMemo(() => {
    if (live && Array.isArray(live.containers) && live.containers.length) {
      const parsed = ContainerListSchema.safeParse(live.containers);
      if (parsed.success) return parsed.data;
    }
    return list.data ?? [];
  }, [live, list.data]);

  const total = containers.length;
  const running = containers.filter(isRunning).length;
  const healthy = containers.filter(c => c.healthcheck === "healthy").length;
  const unhealthy = containers.filter(isUnhealthy).length;
  const restartValues = containers.map(c => c.restartCount).filter((n): n is number => typeof n === "number");
  const restarts = restartValues.length ? restartValues.reduce((a, n) => a + n, 0) : null;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return containers
      .filter(c => {
        if (q && !c.name.toLowerCase().includes(q)) return false;
        if (filter === "running") return isRunning(c);
        if (filter === "exited") return !isRunning(c);
        if (filter === "unhealthy") return isUnhealthy(c);
        return true;
      })
      .sort((a, b) => {
        const ua = isUnhealthy(a) ? 1 : 0;
        const ub = isUnhealthy(b) ? 1 : 0;
        if (ua !== ub) return ub - ua; // unhealthy primeiro
        return (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1); // depois CPU desc
      });
  }, [containers, query, filter]);

  return (
    <div className="space-y-6 animate-fade-up">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        <KpiTile label="Containers" value={list.isLoading && !total ? "…" : total} icon={<Boxes size={14} />} accent="accent" />
        <KpiTile label="Running" value={running} icon={<PlayCircle size={14} />} accent="green" sub={`${total - running} parados`} />
        <KpiTile label="Healthy" value={healthy} icon={<HeartPulse size={14} />} accent="cyan" sub="healthcheck OK" />
        <KpiTile
          label="Unhealthy"
          value={unhealthy > 0 ? <span className="text-red animate-pulse">{unhealthy}</span> : 0}
          icon={<AlertTriangle size={14} />}
          accent={unhealthy > 0 ? "red" : "green"}
          sub={unhealthy > 0 ? "atenção imediata" : "nenhum"}
        />
        <KpiTile
          label="Restarts 24h"
          value={restarts ?? "—"}
          icon={<RotateCcw size={14} />}
          accent={restarts != null && restarts >= THRESHOLDS.restarts24h.warn ? "yellow" : undefined}
          sub="soma dos containers"
        />
      </div>

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/30" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar container por nome…"
            className="w-full bg-black/40 border border-white/10 rounded-md pl-8 pr-3 py-2 text-sm focus:outline-none focus:border-accent/60 placeholder:text-white/30"
            aria-label="Buscar container por nome"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {FILTERS.map(f => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={cn("btn text-xs", filter === f.id && "border-accent/50 text-accent bg-accent/10")}
              aria-pressed={filter === f.id}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <DataBadge source={list.source} stale={list.stale} />
          <span className="text-xs text-white/60 text-mono">{visible.length}/{total}</span>
        </div>
      </div>

      {/* Erro (sem dado anterior) */}
      {list.error && !containers.length && (
        <CardError message={list.error.message} onRetry={list.refresh} />
      )}

      {/* Loading */}
      {list.isLoading && !containers.length && !list.error && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      )}

      {/* Grade */}
      {containers.length > 0 && (
        visible.length === 0 ? (
          <div className="glass-card p-4">
            <EmptyState message="Nenhum container corresponde à busca/filtro." />
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {visible.map(c => {
              const unhealthyCard = isUnhealthy(c);
              const restartsWarn = (c.restartCount ?? 0) >= 3;
              return (
                <Link
                  key={c.name}
                  href={`/srv1/containers/${encodeURIComponent(c.name)}`}
                  className={cn(
                    "glass-card p-5 block transition-all hover:ring-1 hover:ring-accent/60",
                    unhealthyCard && "border border-red/40"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-display font-semibold text-sm truncate" title={c.name}>{c.name}</div>
                      <div className="text-[10px] text-white/40 text-mono truncate mt-0.5" title={c.image ?? undefined}>
                        {c.image || "—"}
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <StatusBadge
                        status={unhealthyCard ? "unhealthy" : c.healthcheck === "healthy" ? "healthy" : isRunning(c) ? "running" : "exited"}
                        pulse={unhealthyCard}
                      />
                    </div>
                  </div>

                  <div className="mt-4 space-y-2.5">
                    <UsageBar label="CPU" value={c.cpuPercent} warn={THRESHOLDS.containerCpu.warn} crit={THRESHOLDS.containerCpu.crit} />
                    <UsageBar label="MEM" value={c.memPercent} warn={THRESHOLDS.containerMem.warn} crit={THRESHOLDS.containerMem.crit} />
                  </div>

                  <div className="mt-3 flex items-center justify-between text-[10px] text-white/40">
                    <span className="flex items-center gap-1"><Clock size={10} /> {c.uptime || "—"}</span>
                    <span className={cn("flex items-center gap-1 text-mono", restartsWarn && "text-yellow")}>
                      <RotateCcw size={10} /> {c.restartCount ?? 0} restarts
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
