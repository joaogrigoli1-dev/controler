"use client";
/**
 * /srv1/containers/[name] — drill-down de container (FASE 4).
 * A tela do memory-leak do incidente 06/2026: memória com linha de tendência
 * (regressão linear das últimas 6h) + badge "possível leak" quando slope
 * positivo sustentado, eventos de estado com OOM-KILL em destaque e ações
 * sensíveis (restart/stop/start) com re-auth OTP.
 */
import Link from "next/link";
import { useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { nocFetch, useNoc } from "@/lib/noc";
import {
  ContainerListSchema,
  ContainerSeriesSchema,
  StateEventListSchema,
  THRESHOLDS,
  ragOf,
  type ContainerRow
} from "@/lib/schemas";
import { mockContainerSeries, mockStateEvents } from "@/lib/mocks";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { DataBadge } from "@/components/noc/DataBadge";
import { CardError } from "@/components/noc/CardError";
import { Skeleton, CardSkeleton } from "@/components/noc/Skeleton";
import { TimeSeriesChart, SERIES } from "@/components/noc/TimeSeriesChart";
import { EventTimeline, type TimelineItem } from "@/components/noc/EventTimeline";
import { OtpActionButton } from "@/components/noc/OtpActionButton";
import { RagBadge } from "@/components/noc/RagBadge";
import { cn, fmtPct } from "@/lib/utils";
import {
  ArrowLeft, RotateCcw, Square, Play, Clock, Cpu, MemoryStick,
  HeartPulse, TrendingUp
} from "lucide-react";

const WINDOWS = [6, 24, 72] as const;

interface ChartRow {
  time: number;
  t: string;
  cpu: number | null;
  mem: number | null;
  rx: number | null;
  tx: number | null;
  br: number | null;
  bw: number | null;
  trend?: number;
  [key: string]: unknown;
}

/** Regressão linear simples (mínimos quadrados). x em horas, y em MB. */
function linearFit(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.x - mx) * (p.y - my);
    den += (p.x - mx) * (p.x - mx);
  }
  if (den === 0) return null;
  const slope = num / den;
  return { slope, intercept: my - slope * mx };
}

export default function ContainerDrillPage() {
  const params = useParams<{ name: string }>();
  const name = decodeURIComponent(String(params?.name ?? ""));
  const [hours, setHours] = useState<(typeof WINDOWS)[number]>(24);

  // Dados atuais (lista /srv1/containers filtrada pelo name)
  const list = useNoc(
    name ? `cont-current-${name}` : null,
    () => nocFetch("/srv1/containers", ContainerListSchema),
    30_000
  );
  const current: ContainerRow | undefined = useMemo(
    () => (list.data ?? []).find(c => c.name === name),
    [list.data, name]
  );

  // Série temporal (analytics; mock rotulado se o coletor FASE 3 estiver pendente)
  const series = useNoc(
    name ? `cont-hist-${name}-${hours}` : null,
    () =>
      nocFetch(`/analytics/containers/${encodeURIComponent(name)}/history?hours=${hours}`, ContainerSeriesSchema, {
        mock: () => mockContainerSeries(name, hours)
      }),
    60_000
  );

  // Eventos de estado (FASE 3 pendente → mock rotulado)
  const events = useNoc(
    name ? `cont-events-${name}` : null,
    () =>
      nocFetch(`/srv1/containers/${encodeURIComponent(name)}/events`, StateEventListSchema, {
        mock: () => mockStateEvents(name)
      }),
    60_000
  );

  const rows: ChartRow[] = useMemo(
    () =>
      (series.data ?? [])
        .map(p => {
          const when = new Date((p.createdAt ?? p.ts ?? Date.now()) as string | number);
          return {
            time: when.getTime(),
            t: when.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
            cpu: p.cpuPercent ?? null,
            mem: p.memUsedMb ?? p.memMb ?? null,
            rx: p.netRxKbps ?? null,
            tx: p.netTxKbps ?? null,
            br: p.blkioReadKbps ?? null,
            bw: p.blkioWriteKbps ?? null
          };
        })
        .sort((a, b) => a.time - b.time),
    [series.data]
  );

  // Tendência 6h da memória (regressão linear) + detecção de possível leak
  const { rowsWithTrend, slopeMbPerHour, possibleLeak } = useMemo(() => {
    const withMem = rows.filter(r => r.mem != null);
    if (!withMem.length) return { rowsWithTrend: rows, slopeMbPerHour: null as number | null, possibleLeak: false };
    const lastTs = withMem[withMem.length - 1].time;
    const cutoff = lastTs - 6 * 3_600_000;
    const windowPts = withMem.filter(r => r.time >= cutoff);
    const fit = linearFit(windowPts.map(r => ({ x: (r.time - cutoff) / 3_600_000, y: r.mem as number })));
    if (!fit) return { rowsWithTrend: rows, slopeMbPerHour: null, possibleLeak: false };
    const merged = rows.map(r =>
      r.time >= cutoff && r.mem != null
        ? { ...r, trend: Math.max(0, fit.intercept + fit.slope * ((r.time - cutoff) / 3_600_000)) }
        : r
    );
    // "Sustentado": slope > 1 MB/h com janela razoável de pontos
    const leak = fit.slope > 1 && windowPts.length >= 6;
    return { rowsWithTrend: merged, slopeMbPerHour: fit.slope, possibleLeak: leak };
  }, [rows]);

  const hasNet = rows.some(r => r.rx != null || r.tx != null);
  const hasBlkio = rows.some(r => r.br != null || r.bw != null);

  const eventItems: TimelineItem[] = useMemo(
    () =>
      (events.data ?? [])
        .slice()
        .sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime())
        .map((e, i) => ({
          id: `${e.ts}-${i}`,
          ts: e.ts,
          title: `${e.fromState ?? "novo"} → ${e.toState}${e.oomKilled ? " (OOM-KILL)" : ""}`,
          severity: e.oomKilled || e.exitCode ? "critical" : "info",
          meta: [e.reason, e.exitCode != null ? `exit ${e.exitCode}` : null].filter(Boolean).join(" · ") || undefined
        })),
    [events.data]
  );

  const refreshAll = () => {
    list.refresh();
    series.refresh();
    events.refresh();
  };

  const unhealthy = current?.healthcheck === "unhealthy";
  const running = current?.state === "running" || Boolean(current?.status?.startsWith("Up"));

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/srv1/containers" className="text-xs text-white/60 hover:text-white/70 flex items-center gap-1 mb-1.5">
            <ArrowLeft size={12} /> Containers
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-display font-bold text-xl text-mono truncate">{name}</h1>
            {current && (
              <StatusBadge
                status={unhealthy ? "unhealthy" : current.healthcheck === "healthy" ? "healthy" : running ? "running" : "exited"}
                pulse={unhealthy}
              />
            )}
            {possibleLeak && (
              <span className="badge badge-yellow" title={`Memória subindo ~${slopeMbPerHour?.toFixed(1)} MB/h nas últimas 6h`}>
                <TrendingUp size={11} /> possível leak
              </span>
            )}
          </div>
          <div className="text-xs text-white/40 text-mono mt-1 flex items-center gap-3 flex-wrap">
            <span className="truncate max-w-[420px]" title={current?.image ?? undefined}>{current?.image || "—"}</span>
            <span className="flex items-center gap-1"><Clock size={11} /> {current?.uptime || "—"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <OtpAction name={name} action="restart" onDone={refreshAll} />
          <OtpAction name={name} action="stop" onDone={refreshAll} />
          <OtpAction name={name} action="start" onDone={refreshAll} />
        </div>
      </div>

      {list.error && !current && <CardError message={list.error.message} onRetry={list.refresh} />}

      {/* Dados atuais */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiTile
          label="CPU"
          value={fmtPct(current?.cpuPercent ?? null)}
          icon={<Cpu size={14} />}
          accent={ragOf(current?.cpuPercent, THRESHOLDS.containerCpu.warn, THRESHOLDS.containerCpu.crit) === "crit" ? "red" : ragOf(current?.cpuPercent, THRESHOLDS.containerCpu.warn, THRESHOLDS.containerCpu.crit) === "warn" ? "yellow" : "cyan"}
        />
        <KpiTile
          label="Memória"
          value={current?.memMb != null ? `${Math.round(current.memMb)} MB` : "—"}
          sub={fmtPct(current?.memPercent ?? null)}
          icon={<MemoryStick size={14} />}
          accent={ragOf(current?.memPercent, THRESHOLDS.containerMem.warn, THRESHOLDS.containerMem.crit) === "crit" ? "red" : ragOf(current?.memPercent, THRESHOLDS.containerMem.warn, THRESHOLDS.containerMem.crit) === "warn" ? "yellow" : "accent"}
        />
        <KpiTile
          label="Health"
          value={<RagBadge rag={unhealthy ? "crit" : current?.healthcheck === "healthy" ? "ok" : "stale"} label={current?.healthcheck ?? "sem healthcheck"} pulse />}
          icon={<HeartPulse size={14} />}
          accent={unhealthy ? "red" : "green"}
        />
        <KpiTile
          label="Restarts"
          value={current?.restartCount ?? "—"}
          icon={<RotateCcw size={14} />}
          accent={(current?.restartCount ?? 0) >= 3 ? "yellow" : undefined}
          sub={(current?.restartCount ?? 0) >= 3 ? "acima do normal" : "contagem total"}
        />
      </div>

      {/* Seletor de janela */}
      <div className="flex items-center gap-2">
        {WINDOWS.map(w => (
          <button
            key={w}
            onClick={() => setHours(w)}
            className={cn("btn text-xs", hours === w && "border-accent/50 text-accent bg-accent/10")}
            aria-pressed={hours === w}
          >
            {w}h
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <DataBadge source={series.source} stale={series.stale} />
        </div>
      </div>

      {series.error && !series.data && <CardError message={series.error.message} onRetry={series.refresh} />}
      {series.isLoading && !series.data && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <CardSkeleton height={260} />
          <CardSkeleton height={260} />
        </div>
      )}

      {rows.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* CPU */}
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="section-title mb-0">CPU % — {hours}h</div>
              <DataBadge source={series.source} stale={series.stale} />
            </div>
            <TimeSeriesChart
              data={rowsWithTrend}
              xKey="t"
              height={220}
              warn={THRESHOLDS.containerCpu.warn}
              crit={THRESHOLDS.containerCpu.crit}
              unit="%"
              series={[{ key: "cpu", label: "CPU %", color: SERIES.teal }]}
            />
          </div>

          {/* Memória + tendência */}
          <div className="glass-card p-5">
            <div className="flex items-center justify-between mb-3">
              <div className="section-title mb-0 flex items-center gap-2">
                Memória (MB) — {hours}h
                {possibleLeak && (
                  <span className="badge badge-yellow">
                    <TrendingUp size={11} /> possível leak (+{slopeMbPerHour?.toFixed(1)} MB/h)
                  </span>
                )}
              </div>
              <DataBadge source={series.source} stale={series.stale} />
            </div>
            <TimeSeriesChart
              data={rowsWithTrend}
              xKey="t"
              height={220}
              unit=" MB"
              legend
              series={[
                { key: "mem", label: "Memória MB", color: SERIES.indigo },
                { key: "trend", label: "tendência 6h", color: SERIES.amber, dashed: true }
              ]}
            />
          </div>

          {/* Rede */}
          {hasNet && (
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="section-title mb-0">Rede RX/TX (Kbps) — {hours}h</div>
                <DataBadge source={series.source} stale={series.stale} />
              </div>
              <TimeSeriesChart
                data={rowsWithTrend}
                xKey="t"
                height={200}
                legend
                series={[
                  { key: "rx", label: "RX Kbps", color: SERIES.teal },
                  { key: "tx", label: "TX Kbps", color: SERIES.indigo }
                ]}
              />
            </div>
          )}

          {/* Block IO */}
          {hasBlkio && (
            <div className="glass-card p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="section-title mb-0">Block IO r/w (Kbps) — {hours}h</div>
                <DataBadge source={series.source} stale={series.stale} />
              </div>
              <TimeSeriesChart
                data={rowsWithTrend}
                xKey="t"
                height={200}
                legend
                series={[
                  { key: "br", label: "read Kbps", color: SERIES.indigo },
                  { key: "bw", label: "write Kbps", color: SERIES.amber }
                ]}
              />
            </div>
          )}
        </div>
      )}

      {/* Eventos de estado */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title mb-0">Eventos de estado</div>
          <DataBadge source={events.source} stale={events.stale} />
        </div>
        {events.error && !events.data && <CardError message={events.error.message} onRetry={events.refresh} />}
        {events.isLoading && !events.data && <Skeleton className="h-24" />}
        {events.data && <EventTimeline items={eventItems} emptyMessage="Nenhuma transição de estado registrada." />}
      </div>
    </div>
  );
}

/** Botões de ação sensível do container (re-auth OTP, RBAC no backend). */
function OtpAction({ name, action, onDone }: { name: string; action: "restart" | "stop" | "start"; onDone: () => void }) {
  const meta = {
    restart: { label: "Restart", icon: <RotateCcw size={13} />, danger: true, text: `Reiniciar o container "${name}". Ele ficará indisponível por alguns segundos durante o restart.` },
    stop: { label: "Stop", icon: <Square size={13} />, danger: true, text: `Parar o container "${name}". O serviço ficará FORA DO AR até um start manual.` },
    start: { label: "Start", icon: <Play size={13} />, danger: false, text: `Iniciar o container "${name}".` }
  }[action];
  return (
    <OtpActionButton
      label={meta.label}
      icon={meta.icon}
      danger={meta.danger}
      confirmText={meta.text}
      action={(otp: string) => api.containerAction(name, action, otp)}
      onDone={onDone}
    />
  );
}
