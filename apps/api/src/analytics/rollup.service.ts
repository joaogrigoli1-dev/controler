/**
 * RollupService — FASE 3: rollups horário/diário das séries RAW.
 *
 * Regras de ouro:
 *   - SEMPRE recomputa do RAW (nunca média incremental, nunca rollup de rollup):
 *     o diário lê o raw do dia inteiro (retenção do raw 10d > 1d, então sempre há dado).
 *   - p95 calculado em JS do array bruto ordenado.
 *   - UPSERT pelos @@unique dos models → jobs idempotentes (reprocessar não duplica).
 *   - Catch-up no onModuleInit: reprocessa buckets faltantes (48h horário / 7d diário).
 *   - Tudo com try/catch + Logger — job nunca derruba o app.
 *
 * Crons:
 *   - "5 * * * *"  → rollup HORÁRIO da hora fechada anterior
 *   - "25 0 * * *" → rollup DIÁRIO do dia (UTC) fechado anterior
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma.service";

const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const CATCHUP_DELAY_MS = 90_000; // deixa o boot estabilizar antes do catch-up

function p95(sorted: number[]): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1));
  return sorted[idx];
}

function avgOf(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function maxOf(nums: number[]): number | null {
  return nums.length ? Math.max(...nums) : null;
}

/** Início do bucket (hora ou dia UTC) que contém `t`. */
function bucketStart(t: number, sizeMs: number): Date {
  return new Date(Math.floor(t / sizeMs) * sizeMs);
}

@Injectable()
export class RollupService implements OnModuleInit {
  private readonly log = new Logger("Rollup");

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    const t = setTimeout(() => {
      this.catchUp().catch(err => this.log.warn(`catch-up falhou: ${err?.message}`));
    }, CATCHUP_DELAY_MS);
    (t as any).unref?.();
  }

  // ─── Crons ────────────────────────────────────────────────

  @Cron("5 * * * *", { name: "rollup-hourly" })
  async hourlyTick() {
    const bucket = bucketStart(Date.now() - HOUR_MS, HOUR_MS); // hora fechada anterior
    try {
      await this.processBucket("hourly", bucket, HOUR_MS);
    } catch (err: any) {
      this.log.error(`rollup horário ${bucket.toISOString()}: ${err?.message}`);
    }
  }

  @Cron("25 0 * * *", { name: "rollup-daily" })
  async dailyTick() {
    const bucket = bucketStart(Date.now() - DAY_MS, DAY_MS); // dia UTC fechado anterior
    try {
      await this.processBucket("daily", bucket, DAY_MS);
    } catch (err: any) {
      this.log.error(`rollup diário ${bucket.toISOString()}: ${err?.message}`);
    }
  }

  /** Reprocessa buckets faltantes: 48h (horário) e 7d (diário). Idempotente via upsert. */
  async catchUp() {
    // Horário: últimas 48 horas fechadas
    const nowHour = bucketStart(Date.now(), HOUR_MS).getTime();
    const existingHourly = await this.prisma.hostMetricRollup
      .findMany({
        where: { granularity: "hourly", bucket: { gte: new Date(nowHour - 48 * HOUR_MS) } },
        select: { bucket: true }
      })
      .catch(() => []);
    const haveHours = new Set(existingHourly.map(r => r.bucket.getTime()));
    for (let i = 48; i >= 1; i--) {
      const b = nowHour - i * HOUR_MS;
      if (haveHours.has(b)) continue;
      try {
        await this.processBucket("hourly", new Date(b), HOUR_MS);
      } catch (err: any) {
        this.log.warn(`catch-up horário ${new Date(b).toISOString()}: ${err?.message}`);
      }
    }
    // Diário: últimos 7 dias fechados
    const nowDay = bucketStart(Date.now(), DAY_MS).getTime();
    const existingDaily = await this.prisma.hostMetricRollup
      .findMany({
        where: { granularity: "daily", bucket: { gte: new Date(nowDay - 7 * DAY_MS) } },
        select: { bucket: true }
      })
      .catch(() => []);
    const haveDays = new Set(existingDaily.map(r => r.bucket.getTime()));
    for (let i = 7; i >= 1; i--) {
      const b = nowDay - i * DAY_MS;
      if (haveDays.has(b)) continue;
      try {
        await this.processBucket("daily", new Date(b), DAY_MS);
      } catch (err: any) {
        this.log.warn(`catch-up diário ${new Date(b).toISOString()}: ${err?.message}`);
      }
    }
    this.log.log("catch-up de rollups concluído");
  }

  // ─── Núcleo: recompute de 1 bucket a partir do RAW ────────

  async processBucket(granularity: "hourly" | "daily", bucket: Date, sizeMs: number) {
    const from = bucket;
    const to = new Date(bucket.getTime() + sizeMs);
    await this.rollupContainers(granularity, from, to, sizeMs);
    await this.rollupHost(granularity, from, to);
    await this.rollupAvailability(granularity, from, to, sizeMs);
  }

  /** ContainerMetricPoint → ContainerMetricRollup (por containerId). */
  private async rollupContainers(granularity: "hourly" | "daily", from: Date, to: Date, sizeMs: number) {
    const points = await this.prisma.containerMetricPoint.findMany({
      where: { ts: { gte: from, lt: to } },
      select: {
        containerId: true,
        cpuPercent: true,
        memUsedMb: true,
        netRxKbps: true,
        netTxKbps: true,
        blkioReadKbps: true,
        blkioWriteKbps: true,
        restartCount: true,
        health: true
      }
    });
    if (!points.length) return;

    const byContainer = new Map<number, typeof points>();
    for (const p of points) {
      const arr = byContainer.get(p.containerId) ?? [];
      arr.push(p);
      byContainer.set(p.containerId, arr);
    }

    for (const [containerId, pts] of byContainer) {
      try {
        const cpus = pts.map(p => p.cpuPercent).sort((a, b) => a - b);
        const mems = pts.map(p => p.memUsedMb);
        const restarts = pts.map(p => p.restartCount).filter((r): r is number => r != null);
        // restartsDelta = crescimento do contador dentro do bucket (clamp ≥ 0)
        const restartsDelta = restarts.length ? Math.max(0, Math.max(...restarts) - Math.min(...restarts)) : 0;
        // unhealthySec ≈ amostras unhealthy × intervalo efetivo do bucket
        const unhealthySamples = pts.filter(p => p.health === "unhealthy").length;
        const bucketSec = sizeMs / 1000;
        const intervalSec = Math.min(bucketSec, bucketSec / Math.max(1, pts.length));
        const unhealthySec = Math.min(bucketSec, Math.round(unhealthySamples * intervalSec));

        const data = {
          sampleCount: pts.length,
          cpuAvg: +(avgOf(cpus) ?? 0).toFixed(2),
          cpuMax: +(maxOf(cpus) ?? 0).toFixed(2),
          cpuP95: p95(cpus) != null ? +p95(cpus)!.toFixed(2) : null, // p95 do RAW, em JS
          memAvgMb: +(avgOf(mems) ?? 0).toFixed(1),
          memMaxMb: +(maxOf(mems) ?? 0).toFixed(1),
          netRxKbpsAvg: this.avgNullable(pts.map(p => p.netRxKbps)),
          netTxKbpsAvg: this.avgNullable(pts.map(p => p.netTxKbps)),
          blkioReadKbpsAvg: this.avgNullable(pts.map(p => p.blkioReadKbps)),
          blkioWriteKbpsAvg: this.avgNullable(pts.map(p => p.blkioWriteKbps)),
          restartsDelta,
          unhealthySec
        };
        await this.prisma.containerMetricRollup.upsert({
          where: { containerId_granularity_bucket: { containerId, granularity, bucket: from } },
          update: data,
          create: { containerId, granularity, bucket: from, ...data }
        });
      } catch (err: any) {
        this.log.warn(`rollup container ${containerId} ${from.toISOString()}: ${err?.message}`);
      }
    }
  }

  /** HostMetricSnapshot (+ HostDiskIoPoint) → HostMetricRollup. */
  private async rollupHost(granularity: "hourly" | "daily", from: Date, to: Date) {
    const snaps = await this.prisma.hostMetricSnapshot.findMany({
      where: { createdAt: { gte: from, lt: to } },
      select: {
        cpuPercent: true,
        loadAvg1m: true,
        memUsedMb: true,
        swapUsedMb: true,
        psiCpuSomeAvg60: true,
        psiIoFullAvg10: true,
        psiMemFullAvg10: true
      }
    });
    if (!snaps.length) return;

    const diskPoints = await this.prisma.hostDiskIoPoint
      .findMany({
        where: { ts: { gte: from, lt: to } },
        select: { utilPercent: true, readAwaitMs: true, writeAwaitMs: true }
      })
      .catch(() => []);
    const awaits = diskPoints
      .flatMap(d => [d.readAwaitMs, d.writeAwaitMs])
      .filter((v): v is number => v != null);

    const cpus = snaps.map(s => s.cpuPercent);
    const mems = snaps.map(s => s.memUsedMb);
    const swaps = snaps.map(s => s.swapUsedMb).filter((v): v is number => v != null);
    const swapMax = maxOf(swaps);

    const data = {
      sampleCount: snaps.length,
      cpuAvg: +(avgOf(cpus) ?? 0).toFixed(2),
      cpuMax: +(maxOf(cpus) ?? 0).toFixed(2),
      loadAvg1mMax: maxOf(snaps.map(s => s.loadAvg1m).filter((v): v is number => v != null)),
      memUsedAvgMb: +(avgOf(mems) ?? 0).toFixed(1),
      memUsedMaxMb: +(maxOf(mems) ?? 0).toFixed(1),
      swapUsedMaxMb: swapMax != null ? Math.round(swapMax) : null,
      psiCpuSomeMax: maxOf(snaps.map(s => s.psiCpuSomeAvg60).filter((v): v is number => v != null)),
      psiIoFullMax: maxOf(snaps.map(s => s.psiIoFullAvg10).filter((v): v is number => v != null)),
      psiMemFullMax: maxOf(snaps.map(s => s.psiMemFullAvg10).filter((v): v is number => v != null)),
      diskUtilMaxPct: maxOf(diskPoints.map(d => d.utilPercent)),
      diskAwaitMaxMs: maxOf(awaits)
    };
    await this.prisma.hostMetricRollup.upsert({
      where: { granularity_bucket: { granularity, bucket: from } },
      update: data,
      create: { granularity, bucket: from, ...data }
    });
  }

  /**
   * AvailabilityRollup por container: downtimeSec somado de ContainerStateEvent
   * (períodos em estado != running dentro do bucket) + uptimePct.
   * checksTotal/checksUp derivados dos metric points do bucket (health).
   * Só cria linha para container com dado no bucket (cobertura honesta).
   */
  private async rollupAvailability(granularity: "hourly" | "daily", from: Date, to: Date, sizeMs: number) {
    const bucketSec = sizeMs / 1000;

    const [events, points, containers] = await Promise.all([
      this.prisma.containerStateEvent.findMany({
        where: { ts: { gte: from, lt: to } },
        orderBy: { ts: "asc" },
        select: { containerId: true, ts: true, toState: true }
      }),
      this.prisma.containerMetricPoint.findMany({
        where: { ts: { gte: from, lt: to } },
        select: { containerId: true, health: true }
      }),
      this.prisma.container.findMany({ select: { id: true, name: true } })
    ]);
    if (!events.length && !points.length) return;
    const nameById = new Map(containers.map(c => [c.id, c.name]));

    // Estado inicial do bucket: último evento ANTES do bucket, por container envolvido
    const involvedIds = Array.from(new Set([...events.map(e => e.containerId), ...points.map(p => p.containerId)]));
    const initialState = new Map<number, string>();
    for (const id of involvedIds) {
      const prev = await this.prisma.containerStateEvent
        .findFirst({
          where: { containerId: id, ts: { lt: from } },
          orderBy: { ts: "desc" },
          select: { toState: true }
        })
        .catch(() => null);
      initialState.set(id, prev?.toState ?? "running"); // sem histórico → assume running
    }

    const eventsByContainer = new Map<number, typeof events>();
    for (const e of events) {
      const arr = eventsByContainer.get(e.containerId) ?? [];
      arr.push(e);
      eventsByContainer.set(e.containerId, arr);
    }
    const pointsByContainer = new Map<number, typeof points>();
    for (const p of points) {
      const arr = pointsByContainer.get(p.containerId) ?? [];
      arr.push(p);
      pointsByContainer.set(p.containerId, arr);
    }

    for (const id of involvedIds) {
      try {
        const name = nameById.get(id);
        if (!name) continue;
        // Varre o bucket somando períodos em estado != running
        let cursor = from.getTime();
        let state = initialState.get(id) ?? "running";
        let downtimeSec = 0;
        let incidents = 0;
        for (const e of eventsByContainer.get(id) ?? []) {
          const t = e.ts.getTime();
          if (state !== "running") downtimeSec += (t - cursor) / 1000;
          if (e.toState !== "running" && state === "running") incidents++;
          state = e.toState;
          cursor = t;
        }
        if (state !== "running") downtimeSec += (to.getTime() - cursor) / 1000;
        downtimeSec = Math.min(bucketSec, Math.max(0, Math.round(downtimeSec)));

        const pts = pointsByContainer.get(id) ?? [];
        const checksTotal = pts.length;
        // E7: contar como "up" APENAS estados saudáveis/rodando.
        // Antes: `health !== "unhealthy" && health !== "exited"` — isso contava
        // "starting" (healthcheck ainda não passou) como up, inflando checksUp.
        // Agora: "healthy" (healthcheck OK) ou "none" (rodando sem healthcheck
        // definido — o coletor converte "none" em "exited" quando o container
        // não está rodando, então "none" implica running). Container preso em
        // "starting" NÃO conta como up. O uptimePct por eventos permanece intacto.
        const checksUp = pts.filter(p => p.health === "healthy" || p.health === "none").length;
        const uptimePct = +(((bucketSec - downtimeSec) / bucketSec) * 100).toFixed(3);

        const data = { checksTotal, checksUp, downtimeSec, incidents, uptimePct };
        await this.prisma.availabilityRollup.upsert({
          where: {
            targetType_targetKey_granularity_bucket: {
              targetType: "container",
              targetKey: name,
              granularity,
              bucket: from
            }
          },
          update: data,
          create: { targetType: "container", targetKey: name, granularity, bucket: from, ...data }
        });
      } catch (err: any) {
        this.log.warn(`availability rollup container ${id} ${from.toISOString()}: ${err?.message}`);
      }
    }
  }

  private avgNullable(vals: Array<number | null>): number | null {
    const nums = vals.filter((v): v is number => v != null);
    const a = avgOf(nums);
    return a != null ? +a.toFixed(2) : null;
  }
}
