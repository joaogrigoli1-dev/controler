"use client";
/**
 * /srv1 — método USE + PSI (a tela do incidente 06/2026).
 * Utilização (CPU/RAM/disco), Saturação (PSI/swap/load por core) e
 * Erros (disco await/util, rede errors/drops/retrans) do host, além de
 * systemd, processos, portas e tabela master de containers (drill-down).
 */
import { useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { api } from "@/lib/api";
import { nocFetch, useNoc } from "@/lib/noc";
import {
  HostDiskIoSchema, HostMetricsSchema, HostNetworkSchema, HostSaturationSchema,
  THRESHOLDS, ragOf, type Rag
} from "@/lib/schemas";
import { mockDiskIo, mockNetwork, mockSaturation } from "@/lib/mocks";
import { useSocketEvent } from "@/lib/socket";
import { Gauge } from "@/components/ui/Gauge";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { RagBadge, ragTextClass } from "@/components/noc/RagBadge";
import { DataBadge } from "@/components/noc/DataBadge";
import { TimeSeriesChart, SERIES } from "@/components/noc/TimeSeriesChart";
import { CardError, EmptyState } from "@/components/noc/CardError";
import { Skeleton, SkeletonRows } from "@/components/noc/Skeleton";
import { cn, fmtBytes, fmtUptime } from "@/lib/utils";
import {
  Activity, AlertOctagon, Boxes, Cpu, HardDrive, MemoryStick, Network, Waves
} from "lucide-react";

// ── helpers ──────────────────────────────────────────────────────────────

function fmtNum(v: number | null | undefined, digits = 1): string {
  if (v == null || Number.isNaN(v)) return "—";
  return v.toFixed(digits);
}

const RAG_ACCENT: Record<Rag, "green" | "yellow" | "red" | "cyan"> = {
  ok: "green",
  warn: "yellow",
  crit: "red",
  stale: "cyan"
};

interface PsiLineData {
  avg10: number;
  avg60: number;
  avg300?: number | null;
}

/** Linha avg10/avg60/avg300 de uma métrica PSI (some ou full). */
function PsiRow({ label, line }: { label: string; line?: PsiLineData | null }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-white/60 uppercase tracking-widest text-[10px]">{label}</span>
      <span className="text-mono text-white/70">
        {line ? `${fmtNum(line.avg10)} / ${fmtNum(line.avg60)} / ${fmtNum(line.avg300)}` : "— / — / —"}
      </span>
    </div>
  );
}

/** Card PSI (CPU/IO/Memória): valor de referência grande + some/full detalhados. */
function PsiCard({
  title, icon, refLabel, value, rag, some, full
}: {
  title: string;
  icon: React.ReactNode;
  /** Qual métrica alimenta o semáforo (ex.: "some avg60"). */
  refLabel: string;
  value: number | null;
  rag: Rag;
  some?: PsiLineData | null;
  full?: PsiLineData | null;
}) {
  return (
    <div className="rounded-md border border-white/5 bg-white/[0.02] p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-white/60">
          {icon} {title}
        </span>
        <RagBadge rag={rag} pulse />
      </div>
      <div className="text-3xl font-bold text-mono">
        {value != null ? `${fmtNum(value)}%` : "—"}
        <span className="text-[10px] text-white/60 font-normal ml-2">{refLabel}</span>
      </div>
      <div className="mt-3 space-y-1.5 border-t border-white/5 pt-2">
        <PsiRow label="some 10s/60s/300s" line={some} />
        {full && <PsiRow label="full 10s/60s/300s" line={full} />}
      </div>
    </div>
  );
}

export default function Srv1Page() {
  // ── Host real validado com Zod (B-04) — endpoint existe, SEM mock ──────
  const hostNoc = useNoc("srv1-host", () => nocFetch("/srv1/host", HostMetricsSchema), 30000);

  // ── Coletores FASE 3 (mock rotulado até existirem) ─────────────────────
  const sat = useNoc("srv1-saturation", () => nocFetch("/srv1/saturation", HostSaturationSchema, { mock: mockSaturation }), 30000);
  const diskio = useNoc("srv1-diskio", () => nocFetch("/srv1/diskio", HostDiskIoSchema, { mock: mockDiskIo }), 30000);
  const net = useNoc("srv1-network", () => nocFetch("/srv1/network", HostNetworkSchema, { mock: mockNetwork }), 30000);

  // ── Endpoints reais existentes (padrão atual) ──────────────────────────
  const { data: services } = useSWR("services", () => api.services(), { refreshInterval: 60000 });
  const [procBy, setProcBy] = useState<"cpu" | "mem">("cpu");
  const { data: procs } = useSWR(["procs", procBy], () => api.processes(procBy), { refreshInterval: 30000 });
  const { data: ports } = useSWR("ports", () => api.ports(), { refreshInterval: 120000 });
  const { data: hist } = useSWR("host-history", () => api.hostHistory(6), { refreshInterval: 60000 });
  const { data: containers } = useSWR("srv1-containers-table", () => api.containers(), { refreshInterval: 30000 });
  const liveHost = useSocketEvent<any>("host:metrics");

  const h = liveHost || hostNoc.data;

  // Load por core: preferimos o valor do coletor de saturação; senão derivamos de loadAvg/nproc.
  const nproc = sat.data?.nproc ?? h?.nproc ?? null;
  const loadPerCore =
    sat.data?.loadPerCore ??
    (h?.loadAvg?.[0] != null && nproc ? h.loadAvg[0] / nproc : null);
  const loadRag = ragOf(loadPerCore, THRESHOLDS.loadPerCore.warn, THRESHOLDS.loadPerCore.crit);

  // PSI — semáforos oficiais da Fase 1: cpu some avg60 · io full avg10 · mem full avg60
  const psi = sat.data?.psi;
  const psiCpuVal = psi?.cpu.some.avg60 ?? null;
  const psiIoVal = psi?.io.full?.avg10 ?? null;
  const psiMemVal = psi?.memory.full?.avg60 ?? null;
  const psiCpuRag = ragOf(psiCpuVal, THRESHOLDS.psiCpuSomeAvg60.warn, THRESHOLDS.psiCpuSomeAvg60.crit);
  const psiIoRag = ragOf(psiIoVal, THRESHOLDS.psiIoFullAvg10.warn, THRESHOLDS.psiIoFullAvg10.crit);
  const psiMemRag = ragOf(psiMemVal, THRESHOLDS.psiMemFullAvg60.warn, THRESHOLDS.psiMemFullAvg60.crit);

  // Swap: so (páginas/s saindo) > 0 sustentado = warn — nunca fingir verde se não temos dado.
  const swap = sat.data?.swap ?? null;
  const swapSo = swap?.outPagesSec ?? null;
  const swapRag: Rag = swapSo == null ? "stale" : swapSo > 0 ? "warn" : "ok";
  const swapPct = swap && swap.totalMb > 0 ? (swap.usedMb / swap.totalMb) * 100 : null;

  // Histórico 6h → TimeSeriesChart com bandas warn/crit de CPU
  const histData = (hist || []).map((p: any) => ({
    t: new Date(p.createdAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }),
    cpu: p.cpuPercent,
    mem: p.memTotalMb ? (p.memUsedMb / p.memTotalMb) * 100 : null
  }));

  // Serviços: failed sempre no topo
  const failedServices = (services || []).filter((s: any) => s.activeState === "failed");
  const okServices = (services || []).filter((s: any) => s.activeState !== "failed");

  const cs = containers || [];

  return (
    <div className="space-y-6 animate-fade-up">
      {/* KPIs topo */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiTile
          label="Uptime"
          value={h?.uptimeSeconds ? fmtUptime(h.uptimeSeconds) : "—"}
          sub="desde último reboot"
          icon={<Activity size={14} />}
          accent="green"
        />
        <KpiTile
          label="Load avg"
          value={h?.loadAvg?.[0]?.toFixed(2) ?? "—"}
          sub={
            loadPerCore != null
              ? `${loadPerCore.toFixed(2)} /core (${nproc ?? "?"} vCPU) · 5m ${h?.loadAvg?.[1]?.toFixed(2) ?? "—"} · 15m ${h?.loadAvg?.[2]?.toFixed(2) ?? "—"}`
              : `5m: ${h?.loadAvg?.[1]?.toFixed(2) ?? "—"} · 15m: ${h?.loadAvg?.[2]?.toFixed(2) ?? "—"}`
          }
          icon={<Cpu size={14} />}
          accent={loadRag === "stale" ? "cyan" : RAG_ACCENT[loadRag]}
        />
        <KpiTile label="Net in" value={fmtBytes(Number(h?.netInBytes || 0))} icon={<Network size={14} />} sub="último período" />
        <KpiTile label="Net out" value={fmtBytes(Number(h?.netOutBytes || 0))} icon={<Network size={14} />} sub="último período" />
      </div>

      {/* Gauges + histórico 6h */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="glass-card p-6">
          <div className="flex items-center gap-2 mb-3">
            <div className="section-title mb-0">Gauges em tempo real</div>
            <DataBadge source={hostNoc.source} stale={hostNoc.stale} />
          </div>
          {hostNoc.error && !h ? (
            <CardError message={hostNoc.error.message} onRetry={hostNoc.refresh} />
          ) : !h ? (
            <div className="grid grid-cols-3 gap-4 place-items-center">
              {[1, 2, 3].map(i => <Skeleton key={i} className="w-[110px] h-[110px] rounded-full" />)}
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-4 place-items-center">
              <Gauge value={h?.cpuPercent ?? 0} label="CPU" size={120} thresholds={[THRESHOLDS.cpuPercent.warn, THRESHOLDS.cpuPercent.crit]} />
              <Gauge value={h?.memPercent ?? 0} label="RAM" size={120} thresholds={[THRESHOLDS.memPercent.warn, THRESHOLDS.memPercent.crit]} />
              <Gauge value={h?.diskPercent ?? 0} label="DISK" size={120} thresholds={[THRESHOLDS.diskPercent.warn, THRESHOLDS.diskPercent.crit]} />
            </div>
          )}
        </div>
        <div className="glass-card p-6 lg:col-span-2">
          <div className="section-title">CPU / RAM — Últimas 6h</div>
          {!hist ? (
            <Skeleton className="h-[200px]" />
          ) : (
            <TimeSeriesChart
              data={histData}
              series={[
                { key: "cpu", label: "CPU %", color: SERIES.teal },
                { key: "mem", label: "RAM %", color: SERIES.indigo }
              ]}
              xKey="t"
              height={200}
              warn={THRESHOLDS.cpuPercent.warn}
              crit={THRESHOLDS.cpuPercent.crit}
              yDomain={[0, 100]}
              legend
            />
          )}
        </div>
      </div>

      {/* SATURAÇÃO (PSI) — o sinal que teria pego o incidente 06/2026 */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-4">
          <Waves size={13} className="text-accent" aria-hidden="true" />
          <div className="section-title mb-0">Saturação (PSI)</div>
          <DataBadge source={sat.source} stale={sat.stale} />
        </div>
        {sat.isLoading && !sat.data ? (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map(i => <Skeleton key={i} className="h-36" />)}
          </div>
        ) : sat.error && !sat.data ? (
          <CardError message={sat.error.message} onRetry={sat.refresh} />
        ) : (
          <>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <PsiCard
                title="CPU"
                icon={<Cpu size={12} />}
                refLabel="some avg60"
                value={psiCpuVal}
                rag={psiCpuRag}
                some={psi?.cpu.some}
                full={psi?.cpu.full ?? null}
              />
              <PsiCard
                title="IO"
                icon={<HardDrive size={12} />}
                refLabel="full avg10"
                value={psiIoVal}
                rag={psiIoRag}
                some={psi?.io.some}
                full={psi?.io.full ?? null}
              />
              <PsiCard
                title="Memória"
                icon={<MemoryStick size={12} />}
                refLabel="full avg60"
                value={psiMemVal}
                rag={psiMemRag}
                some={psi?.memory.some}
                full={psi?.memory.full ?? null}
              />
            </div>
            {/* Swap + load por core */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div className="rounded-md border border-white/5 bg-white/[0.02] p-4 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-white/60 mb-1">Swap</div>
                  <div className="text-xl font-bold text-mono">
                    {swap ? `${fmtNum(swap.usedMb, 0)} / ${fmtNum(swap.totalMb, 0)} MB` : "—"}
                    {swapPct != null && <span className="text-[10px] text-white/60 font-normal ml-2">{fmtNum(swapPct)}%</span>}
                  </div>
                  <div className="text-xs text-white/60 text-mono mt-1">
                    si {swap?.inPagesSec ?? "—"} · so {swap?.outPagesSec ?? "—"} pág/s
                  </div>
                </div>
                <RagBadge rag={swapRag} label={swapRag === "warn" ? "SWAPPING" : undefined} />
              </div>
              <div className="rounded-md border border-white/5 bg-white/[0.02] p-4 flex items-center justify-between">
                <div>
                  <div className="text-[10px] uppercase tracking-widest text-white/60 mb-1">Load por core</div>
                  <div className="text-xl font-bold text-mono">
                    {loadPerCore != null ? fmtNum(loadPerCore, 2) : "—"}
                    <span className="text-[10px] text-white/60 font-normal ml-2">{nproc ?? "—"} vCPU</span>
                  </div>
                  <div className="text-xs text-white/60 text-mono mt-1">
                    W {THRESHOLDS.loadPerCore.warn.toFixed(1)} · C {THRESHOLDS.loadPerCore.crit.toFixed(1)}
                  </div>
                </div>
                <RagBadge rag={loadRag} />
              </div>
            </div>
          </>
        )}
      </div>

      {/* DISCO / IO por device */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-2 mb-3">
          <HardDrive size={13} className="text-accent" aria-hidden="true" />
          <div className="section-title mb-0">Disco / IO</div>
          <DataBadge source={diskio.source} stale={diskio.stale} />
        </div>
        {diskio.isLoading && !diskio.data ? (
          <SkeletonRows n={3} />
        ) : diskio.error && !diskio.data ? (
          <CardError message={diskio.error.message} onRetry={diskio.refresh} />
        ) : !diskio.data?.devices.length ? (
          <EmptyState message="Nenhum device reportado." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-white/60 text-[10px] uppercase tracking-widest">
                <tr>
                  <th className="text-left py-2">Device</th>
                  <th className="text-right">Util%</th>
                  <th className="text-right">Await R (ms)</th>
                  <th className="text-right">Await W (ms)</th>
                  <th className="text-right hidden sm:table-cell">IOPS R/W</th>
                  <th className="text-right hidden md:table-cell">KB/s R/W</th>
                  <th className="text-right hidden md:table-cell">Fila</th>
                </tr>
              </thead>
              <tbody>
                {diskio.data.devices.map(d => {
                  const utilRag = ragOf(d.utilPercent, THRESHOLDS.diskUtilPercent.warn, THRESHOLDS.diskUtilPercent.crit);
                  const awaitMax = Math.max(d.readAwaitMs ?? 0, d.writeAwaitMs ?? 0);
                  const awaitRag = ragOf(
                    d.readAwaitMs == null && d.writeAwaitMs == null ? null : awaitMax,
                    THRESHOLDS.diskAwaitMs.warn,
                    THRESHOLDS.diskAwaitMs.crit
                  );
                  return (
                    <tr key={d.device} className="border-t border-white/5">
                      <td className="py-2 text-mono text-cyan">{d.device}</td>
                      <td className="text-right">
                        <span className="inline-flex items-center gap-2 justify-end">
                          <span className={cn("text-mono", ragTextClass(utilRag))}>{fmtNum(d.utilPercent)}%</span>
                          <RagBadge rag={utilRag} />
                        </span>
                      </td>
                      <td className={cn("text-right text-mono", ragTextClass(awaitRag))}>{fmtNum(d.readAwaitMs)}</td>
                      <td className={cn("text-right text-mono", ragTextClass(awaitRag))}>{fmtNum(d.writeAwaitMs)}</td>
                      <td className="text-right text-mono text-white/70 hidden sm:table-cell">
                        {fmtNum(d.readIops, 0)} / {fmtNum(d.writeIops, 0)}
                      </td>
                      <td className="text-right text-mono text-white/70 hidden md:table-cell">
                        {fmtNum(d.readKbps, 0)} / {fmtNum(d.writeKbps, 0)}
                      </td>
                      <td className="text-right text-mono text-white/70 hidden md:table-cell">{fmtNum(d.avgQueueSize, 2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* REDE por interface */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Network size={13} className="text-accent" aria-hidden="true" />
            <div className="section-title mb-0">Rede</div>
            <DataBadge source={net.source} stale={net.stale} />
          </div>
          <span className="text-xs text-white/60 text-mono">
            TCP retrans: {net.data?.tcpRetransPercent != null ? `${fmtNum(net.data.tcpRetransPercent, 2)}%` : "—"}
          </span>
        </div>
        {net.isLoading && !net.data ? (
          <SkeletonRows n={2} />
        ) : net.error && !net.data ? (
          <CardError message={net.error.message} onRetry={net.refresh} />
        ) : !net.data?.ifaces.length ? (
          <EmptyState message="Nenhuma interface reportada." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-white/60 text-[10px] uppercase tracking-widest">
                <tr>
                  <th className="text-left py-2">Interface</th>
                  <th className="text-right">RX Kbps</th>
                  <th className="text-right">TX Kbps</th>
                  <th className="text-right">Erros RX/TX</th>
                  <th className="text-right">Drops RX/TX</th>
                  <th className="text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {net.data.ifaces.map(n => {
                  const errs = (n.rxErrors ?? 0) + (n.txErrors ?? 0);
                  const drops = (n.rxDrops ?? 0) + (n.txDrops ?? 0);
                  const hasCounters = n.rxErrors != null || n.txErrors != null || n.rxDrops != null || n.txDrops != null;
                  const rag: Rag = !hasCounters ? "stale" : errs + drops > 0 ? "crit" : "ok";
                  return (
                    <tr key={n.iface} className="border-t border-white/5">
                      <td className="py-2 text-mono text-cyan">{n.iface}</td>
                      <td className="text-right text-mono text-white/80">{fmtNum(n.rxKbps, 0)}</td>
                      <td className="text-right text-mono text-white/80">{fmtNum(n.txKbps, 0)}</td>
                      <td className={cn("text-right text-mono", errs > 0 ? "text-red" : "text-white/60")}>
                        {n.rxErrors ?? "—"} / {n.txErrors ?? "—"}
                      </td>
                      <td className={cn("text-right text-mono", drops > 0 ? "text-red" : "text-white/60")}>
                        {n.rxDrops ?? "—"} / {n.txDrops ?? "—"}
                      </td>
                      <td className="text-right"><RagBadge rag={rag} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Serviços systemd (failed no topo) + Top processos (toggle CPU/MEM) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">Serviços systemd</div>
            {failedServices.length > 0 ? (
              <span className="badge badge-red">
                <AlertOctagon size={11} /> {failedServices.length} failed
              </span>
            ) : services ? (
              <span className="badge badge-green">0 failed</span>
            ) : null}
          </div>
          {!services ? (
            <SkeletonRows n={6} />
          ) : (
            <div className="space-y-1.5 text-sm max-h-[360px] overflow-y-auto">
              {[...failedServices, ...okServices].map((s: any) => (
                <div
                  key={s.name}
                  className={cn(
                    "flex items-center justify-between p-2 rounded hover:bg-white/[0.03]",
                    s.activeState === "failed" && "bg-red/5 border border-red/20"
                  )}
                >
                  <div>
                    <div className="text-mono text-xs text-white/90">{s.name}</div>
                    <div className="text-[10px] text-white/60">{s.description}</div>
                  </div>
                  <StatusBadge status={s.activeState === "active" ? "running" : s.activeState === "failed" ? "red" : "muted"} label={s.subState} />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="glass-card p-6">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0">Top processos</div>
            <div className="flex items-center gap-1">
              {(["cpu", "mem"] as const).map(k => (
                <button
                  key={k}
                  onClick={() => setProcBy(k)}
                  className={cn(
                    "btn text-[10px] uppercase tracking-widest px-2.5 py-1",
                    procBy === k && "bg-accent/20 text-accent border-accent/40"
                  )}
                  aria-pressed={procBy === k}
                >
                  {k === "cpu" ? "CPU" : "MEM"}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-white/60 text-[10px] uppercase tracking-widest">
                <tr>
                  <th className="text-left py-2">PID</th>
                  <th className="text-left hidden sm:table-cell">User</th>
                  <th className="text-right">CPU%</th>
                  <th className="text-right">MEM%</th>
                  <th className="text-left pl-3 hidden md:table-cell">Cmd</th>
                </tr>
              </thead>
              <tbody>
                {!procs && [1, 2, 3, 4, 5].map(i => (
                  <tr key={`sk-${i}`} className="border-t border-white/5">
                    <td colSpan={5} className="py-2">
                      <div className="h-3 bg-white/[0.04] rounded animate-pulse" />
                    </td>
                  </tr>
                ))}
                {procs?.length === 0 && (
                  <tr><td colSpan={5} className="py-6 text-center text-white/60">Nenhum processo encontrado</td></tr>
                )}
                {(procs || []).slice(0, 8).map((p: any) => (
                  <tr key={p.pid} className="border-t border-white/5">
                    <td className="py-1.5 text-mono">{p.pid}</td>
                    <td className="text-white/70 hidden sm:table-cell">{p.user}</td>
                    <td className={cn("text-right text-mono", procBy === "cpu" && "text-cyan")}>{p.cpu?.toFixed(1)}</td>
                    <td className={cn("text-right text-mono", procBy === "mem" && "text-cyan")}>{p.mem?.toFixed(1)}</td>
                    <td className="pl-3 text-white/70 truncate max-w-[280px] hidden md:table-cell" title={p.command}>{p.command}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Portas em escuta */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="section-title mb-0">Portas em escuta</div>
          <span className="text-xs text-white/60 text-mono">{ports?.length ?? 0} sockets</span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 text-xs">
          {(ports || []).map((p: any, i: number) => (
            <div key={i} className="flex items-center justify-between p-2 rounded bg-white/[0.02]">
              <span className="text-mono text-cyan">{p.local}</span>
              <span className="text-white/40">{p.process}</span>
            </div>
          ))}
        </div>
      </div>

      {/* TABELA MASTER DE CONTAINERS — cada linha navega ao drill-down */}
      <div className="glass-card p-6">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Boxes size={13} className="text-accent" aria-hidden="true" />
            <div className="section-title mb-0">Containers</div>
          </div>
          <span className="text-xs text-white/60 text-mono">{cs.length} containers · clique para drill-down</span>
        </div>
        {!containers ? (
          <SkeletonRows n={8} />
        ) : cs.length === 0 ? (
          <EmptyState message="Nenhum container reportado." />
        ) : (
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-[minmax(0,1.6fr)_90px_92px_64px_64px_72px_96px] gap-2 items-center px-2 py-2 text-[10px] uppercase tracking-widest text-white/60">
                <span>Nome</span>
                <span>Estado</span>
                <span>Health</span>
                <span className="text-right">CPU%</span>
                <span className="text-right">MEM%</span>
                <span className="text-right">Restarts</span>
                <span className="text-right">Uptime</span>
              </div>
              {cs.map((c: any) => {
                const cpuRag = ragOf(c.cpuPercent, THRESHOLDS.containerCpu.warn, THRESHOLDS.containerCpu.crit);
                const memRag = ragOf(c.memPercent, THRESHOLDS.containerMem.warn, THRESHOLDS.containerMem.crit);
                const restartRag = ragOf(c.restartCount, THRESHOLDS.restarts24h.warn, THRESHOLDS.restarts24h.crit);
                return (
                  <Link
                    key={c.name}
                    href={`/srv1/containers/${encodeURIComponent(c.name)}`}
                    className="grid grid-cols-[minmax(0,1.6fr)_90px_92px_64px_64px_72px_96px] gap-2 items-center px-2 py-2 rounded-md border-t border-white/5 text-xs hover:bg-white/[0.04] transition"
                  >
                    <span className="text-mono text-white/90 truncate" title={c.name}>{c.name}</span>
                    <span><StatusBadge status={c.state ?? c.status ?? "?"} /></span>
                    <span>
                      {c.healthcheck ? <StatusBadge status={c.healthcheck} /> : <span className="text-white/30 text-mono">—</span>}
                    </span>
                    <span className={cn("text-right text-mono", ragTextClass(cpuRag))}>
                      {c.cpuPercent != null ? c.cpuPercent.toFixed(1) : "—"}
                    </span>
                    <span className={cn("text-right text-mono", ragTextClass(memRag))}>
                      {c.memPercent != null ? c.memPercent.toFixed(0) : "—"}
                    </span>
                    <span className={cn("text-right text-mono", ragTextClass(restartRag))}>
                      {c.restartCount ?? "—"}
                    </span>
                    <span className="text-right text-mono text-white/60 truncate" title={c.uptime ?? ""}>
                      {c.uptime ?? "—"}
                    </span>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
