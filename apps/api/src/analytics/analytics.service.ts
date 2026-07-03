/**
 * AnalyticsService — KPIs agregados do NOC, MTTR/MTBF, tendências, distribuições.
 *
 * Estendido em 2026-06-04: 12+ KPIs ao invés dos 4 originais (deploys, alertas,
 * críticos, MTTR). Agora cobre: uptime do host, success-rate de deploys, distribuição
 * de severidade, throughput de scanner, sites uptime, alertas por canal e top
 * containers por CPU/RAM nas últimas 24h.
 *
 * FASE 3 (2026-07-02):
 *   - GET /analytics/reliability → ReliabilitySchema (availability/coverage/MTTR/
 *     MTBF/TTD/incidentes/deploys/byTarget/dailyAvailability), com fallback
 *     documentado enquanto os coletores enchem as tabelas novas.
 *   - GET /analytics/health → HealthOverviewSchema (golden signals compostos,
 *     score 0-100, mostImportant), cache Redis 20s.
 *   - containerMetricsHistory lê ContainerMetricPoint (registry) com fallback
 *     para MetricSnapshot legado.
 *   - hostUptimePercent (Gap #4): expected derivado do intervalo REAL (mediana
 *     do delta entre snapshots) — sem acoplamento com o realtime/metrics.scheduler.
 */

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { RedisService } from "../common/redis.service";
import { CoolifyService } from "../coolify/coolify.service";

type Rag = "ok" | "warn" | "crit" | "stale";

interface Signal {
  value: number | null;
  unit: string;
  rag: Rag;
  label: string;
  spark?: number[];
}

/** Limiar W/C → RAG (espelho de apps/web/lib/schemas.ts ragOf). */
function ragOf(value: number | null | undefined, warn: number, crit: number): Rag {
  if (value == null || Number.isNaN(value)) return "stale";
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function worstRag(...rags: Rag[]): Rag {
  const order: Rag[] = ["crit", "warn", "stale", "ok"];
  for (const r of order) if (rags.includes(r)) return r;
  return "ok";
}

function avg(nums: number[]): number | null {
  if (!nums.length) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

@Injectable()
export class AnalyticsService {
  private readonly log = new Logger("Analytics");

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly coolify: CoolifyService
  ) {}

  /**
   * KPIs principais do dashboard /analytics, comparando período atual vs anterior.
   */
  async overviewKpis(periodDays = 7) {
    const since = new Date(Date.now() - periodDays * 24 * 3600_000);
    const prevSince = new Date(Date.now() - 2 * periodDays * 24 * 3600_000);

    const [
      deploys,
      deploysPrev,
      deploysSuccess,
      deploysFailed,
      alerts,
      alertsPrev,
      criticalNow,
      warningNow,
      mttr,
      scannerFindingsOpen,
      sitesOnline,
      sitesTotal,
      apisHealthy,
      apisTotal
    ] = await Promise.all([
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since } } }),
      this.prisma.deployHistory.count({ where: { startedAt: { gte: prevSince, lt: since } } }),
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since }, status: "success" } }),
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since }, status: "failed" } }),
      this.prisma.alertLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.alertLog.count({ where: { createdAt: { gte: prevSince, lt: since } } }),
      this.prisma.alertLog.count({ where: { severity: "critical", createdAt: { gte: since } } }),
      this.prisma.alertLog.count({ where: { severity: "warning", createdAt: { gte: since } } }),
      this.mttr(periodDays),
      this.prisma.scannerFinding.count({ where: { resolved: false } }).catch(() => 0),
      this.prisma.site.count({ where: { statusCode: { lt: 400 } } }).catch(() => 0),
      this.prisma.site.count().catch(() => 0),
      this.prisma.projectApi.count({ where: { status: "healthy" } }).catch(() => 0),
      this.prisma.projectApi.count().catch(() => 0)
    ]);

    const deployTotal = deploysSuccess + deploysFailed;
    const successRate = deployTotal > 0 ? Math.round((deploysSuccess / deployTotal) * 100) : null;

    return {
      periodDays,
      deploys: {
        current: deploys,
        previous: deploysPrev,
        delta: deploys - deploysPrev,
        success: deploysSuccess,
        failed: deploysFailed,
        successRate
      },
      alerts: {
        current: alerts,
        previous: alertsPrev,
        delta: alerts - alertsPrev,
        critical: criticalNow,
        warning: warningNow
      },
      mttrMinutes: mttr,
      scanner: { openFindings: scannerFindingsOpen },
      sites: { online: sitesOnline, total: sitesTotal },
      apis: { healthy: apisHealthy, total: apisTotal }
    };
  }

  /**
   * MTTR (FASE 3): média(resolvido − detectado) de alertas CRITICAL pareados
   * com a recuperação registrada na timeline (metadata.ruleKey igual, severity
   * não-critical posterior) ou com um AlertLog de recuperação (mesma ruleKey,
   * severity info/warning posterior). Considera 1 alerta por incidente
   * (agrupado por ruleKey+dia). Duração é limitada a 24h (pares espúrios).
   * Se houver menos de 3 pares, retorna null (dado insuficiente — @validacao).
   *
   * Fallback: se nenhum par for encontrado, usa a heurística antiga de deploys
   * (FAIL → próximo SUCCESS do mesmo projeto).
   */
  async mttr(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 24 * 3600_000);
    const MAX_RESOLUTION_MS = 24 * 3600_000;

    try {
      const criticals = await this.prisma.alertLog.findMany({
        where: { severity: "critical", createdAt: { gte: since } },
        select: { ruleKey: true, createdAt: true },
        orderBy: { createdAt: "asc" },
        take: 500
      });
      // 1 incidente por (ruleKey, dia) — primeiro alerta do grupo é a detecção
      const firstOfIncident = new Map<string, { ruleKey: string; createdAt: Date }>();
      for (const a of criticals) {
        const key = `${a.ruleKey}|${a.createdAt.toISOString().slice(0, 10)}`;
        if (!firstOfIncident.has(key)) firstOfIncident.set(key, a);
      }
      const incidents = Array.from(firstOfIncident.values()).slice(0, 50);
      const durationsMin: number[] = [];
      for (const inc of incidents) {
        const [tlRecovery, alertRecovery] = await Promise.all([
          this.prisma.timelineEvent.findFirst({
            where: {
              createdAt: { gt: inc.createdAt },
              severity: { not: "critical" },
              metadata: { path: ["ruleKey"], equals: inc.ruleKey }
            },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true }
          }),
          this.prisma.alertLog.findFirst({
            where: {
              createdAt: { gt: inc.createdAt },
              ruleKey: inc.ruleKey,
              severity: { in: ["info", "warning"] }
            },
            orderBy: { createdAt: "asc" },
            select: { createdAt: true }
          })
        ]);
        const candidates = [tlRecovery?.createdAt, alertRecovery?.createdAt]
          .filter((d): d is Date => !!d)
          .map(d => d.getTime());
        if (!candidates.length) continue;
        const resolvedAt = Math.min(...candidates);
        const ms = resolvedAt - inc.createdAt.getTime();
        if (ms > 0 && ms <= MAX_RESOLUTION_MS) durationsMin.push(ms / 60_000);
      }
      if (durationsMin.length >= 3) {
        return Math.round(durationsMin.reduce((a, b) => a + b, 0) / durationsMin.length);
      }
    } catch (err: any) {
      this.log.warn(`mttr via AlertLog falhou: ${err?.message}`);
    }

    // Fallback legado: FAIL de deploy → próximo SUCCESS do mesmo projeto
    const fails = await this.prisma.deployHistory.findMany({
      where: { startedAt: { gte: since }, status: "failed" },
      select: { project: true, startedAt: true }
    });
    if (!fails.length) return null;
    let totalMin = 0;
    let n = 0;
    for (const f of fails) {
      const next = await this.prisma.deployHistory.findFirst({
        where: { project: f.project, status: "success", startedAt: { gt: f.startedAt } },
        orderBy: { startedAt: "asc" }
      });
      if (next) {
        totalMin += (next.startedAt.getTime() - f.startedAt.getTime()) / 60_000;
        n++;
      }
    }
    return n ? Math.round(totalMin / n) : null;
  }

  async hostMetricsHistory(hours = 24) {
    const since = new Date(Date.now() - hours * 3600_000);
    return this.prisma.hostMetricSnapshot.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        cpuPercent: true,
        memUsedMb: true,
        memTotalMb: true,
        diskUsedGb: true,
        diskTotalGb: true,
        loadAvg5m: true
      }
    });
  }

  /**
   * FASE 3: lê ContainerMetricPoint (registry por nome) quando houver linhas;
   * fallback para MetricSnapshot legado. Shape compatível com o anterior
   * (createdAt/cpuPercent/memMb/memPercent) + campos novos (netRxKbps etc.).
   */
  async containerMetricsHistory(name: string, hours = 24) {
    const since = new Date(Date.now() - hours * 3600_000);
    try {
      const container = await this.prisma.container.findUnique({ where: { name }, select: { id: true } });
      if (container) {
        const points = await this.prisma.containerMetricPoint.findMany({
          where: { containerId: container.id, ts: { gte: since } },
          orderBy: { ts: "asc" },
          select: {
            ts: true,
            cpuPercent: true,
            memUsedMb: true,
            memPercent: true,
            netRxKbps: true,
            netTxKbps: true,
            blkioReadKbps: true,
            blkioWriteKbps: true,
            restartCount: true,
            health: true
          }
        });
        if (points.length) {
          return points.map(p => ({
            createdAt: p.ts,
            ts: p.ts,
            cpuPercent: p.cpuPercent,
            memMb: p.memUsedMb, // retrocompat com o shape antigo
            memUsedMb: p.memUsedMb,
            memPercent: p.memPercent,
            netRxKbps: p.netRxKbps,
            netTxKbps: p.netTxKbps,
            blkioReadKbps: p.blkioReadKbps,
            blkioWriteKbps: p.blkioWriteKbps,
            restartCount: p.restartCount,
            health: p.health
          }));
        }
      }
    } catch (err: any) {
      this.log.warn(`containerMetricsHistory(${name}) via registry falhou: ${err?.message}`);
    }
    // Fallback: snapshots legados
    return this.prisma.metricSnapshot.findMany({
      where: { containerName: name, createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, cpuPercent: true, memMb: true, memPercent: true }
    });
  }

  /**
   * Top containers por consumo médio nas últimas N horas.
   * Útil para identificar o que está custando recurso.
   */
  async topContainersByResource(
    by: "cpu" | "mem" = "cpu",
    hours = 24,
    limit = 10
  ): Promise<Array<{ name: string; avgCpu: number; avgMem: number; samples: number }>> {
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = await this.prisma.metricSnapshot.findMany({
      where: { createdAt: { gte: since }, containerName: { not: null } },
      select: { containerName: true, cpuPercent: true, memPercent: true }
    });
    const agg: Record<string, { cpuSum: number; memSum: number; n: number }> = {};
    for (const r of rows) {
      const key = r.containerName!;
      const a = agg[key] ?? { cpuSum: 0, memSum: 0, n: 0 };
      a.cpuSum += r.cpuPercent ?? 0;
      a.memSum += r.memPercent ?? 0;
      a.n++;
      agg[key] = a;
    }
    const ranked = Object.entries(agg)
      .map(([name, a]) => ({
        name,
        avgCpu: +(a.cpuSum / a.n).toFixed(2),
        avgMem: +(a.memSum / a.n).toFixed(2),
        samples: a.n
      }))
      .sort((x, y) => (by === "cpu" ? y.avgCpu - x.avgCpu : y.avgMem - x.avgMem))
      .slice(0, limit);
    return ranked;
  }

  /**
   * Intervalo EFETIVO de coleta (ms): mediana do delta entre os últimos
   * snapshots do host (mediana resiste a buracos de outage, que inflariam a média).
   * Clamp em [10s, 1h]. null quando há < 2 amostras.
   */
  private async effectiveSnapshotIntervalMs(): Promise<number | null> {
    const rows = await this.prisma.hostMetricSnapshot.findMany({
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { createdAt: true }
    });
    if (rows.length < 2) return null;
    const deltas: number[] = [];
    for (let i = 0; i < rows.length - 1; i++) {
      deltas.push(rows[i].createdAt.getTime() - rows[i + 1].createdAt.getTime());
    }
    const med = median(deltas);
    if (med == null) return null;
    return Math.min(3600_000, Math.max(10_000, Math.round(med)));
  }

  /**
   * Uptime do host nas últimas N horas = cobertura de snapshots.
   * FASE 3 (Gap #4): expected = janela / intervalo REAL (mediana do delta entre
   * snapshots) — nada de cadência hardcoded (60/h reportava ~20% com host são)
   * nem de constante importada de outro módulo (acoplamento removido).
   */
  async hostUptimePercent(
    hours = 24
  ): Promise<{ uptimePercent: number; samples: number; expected: number; intervalMs: number | null }> {
    const since = new Date(Date.now() - hours * 3600_000);
    const samples = await this.prisma.hostMetricSnapshot.count({
      where: { createdAt: { gte: since } }
    });
    const intervalMs = await this.effectiveSnapshotIntervalMs();
    if (!intervalMs || samples === 0) {
      return { uptimePercent: samples > 0 ? 100 : 0, samples, expected: Math.max(1, samples), intervalMs };
    }
    const expected = Math.max(1, Math.round((hours * 3600_000) / intervalMs));
    const ratio = Math.min(100, (samples / expected) * 100);
    return { uptimePercent: +ratio.toFixed(1), samples, expected, intervalMs };
  }

  /**
   * Distribuição de alertas por canal e severidade nas últimas N horas.
   */
  async alertsBreakdown(hours = 24) {
    const since = new Date(Date.now() - hours * 3600_000);
    const logs = await this.prisma.alertLog.findMany({
      where: { createdAt: { gte: since } },
      select: { severity: true, channels: true, sent: true }
    });
    const bySeverity: Record<string, number> = { info: 0, warning: 0, critical: 0 };
    const byChannel: Record<string, number> = {};
    let sent = 0;
    let failed = 0;
    for (const l of logs) {
      bySeverity[l.severity] = (bySeverity[l.severity] || 0) + 1;
      for (const ch of l.channels || []) byChannel[ch] = (byChannel[ch] || 0) + 1;
      if (l.sent) sent++;
      else failed++;
    }
    return {
      total: logs.length,
      bySeverity,
      byChannel,
      delivery: { sent, failed, rate: logs.length ? +((sent / logs.length) * 100).toFixed(1) : null }
    };
  }

  // ─────────────────────────────────────────────────────────
  // FASE 3 — GET /analytics/reliability (ReliabilitySchema)
  // ─────────────────────────────────────────────────────────

  /**
   * Confiabilidade da janela. Deriva de ContainerStateEvent/AvailabilityRollup
   * quando existirem; enquanto o coletor enche as tabelas, cai no fallback
   * documentado (Site.statusCode / presença de snapshots) com coveragePct baixo.
   * Campos sem dado = null — NUNCA erro, NUNCA 100% inventado.
   */
  async reliability(days = 30) {
    const windowMs = days * 24 * 3600_000;
    const since = new Date(Date.now() - windowMs);

    // ── Deploys na janela ──
    const [deploysTotal, deploysSuccess, deploysFailed] = await Promise.all([
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since } } }),
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since }, status: "success" } }),
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since }, status: "failed" } })
    ]);
    const finished = deploysSuccess + deploysFailed;
    const deploySuccessRatePct = finished > 0 ? +((deploysSuccess / finished) * 100).toFixed(1) : null;

    // ── Incidentes: AlertLog critical agrupado por (ruleKey, dia) ──
    const criticals = await this.prisma.alertLog.findMany({
      where: { severity: "critical", createdAt: { gte: since } },
      select: { ruleKey: true, createdAt: true },
      orderBy: { createdAt: "asc" }
    });
    const incidentFirstTs = new Map<string, number>();
    for (const a of criticals) {
      const key = `${a.ruleKey}|${a.createdAt.toISOString().slice(0, 10)}`;
      if (!incidentFirstTs.has(key)) incidentFirstTs.set(key, a.createdAt.getTime());
    }
    const incidentTimes = Array.from(incidentFirstTs.values()).sort((a, b) => a - b);
    const incidentCount = incidentTimes.length;

    // MTBF: média do delta entre incidentes consecutivos; null se < 5 (regra @validacao)
    let mtbfHours: number | null = null;
    if (incidentCount >= 5) {
      const deltas: number[] = [];
      for (let i = 1; i < incidentTimes.length; i++) deltas.push(incidentTimes[i] - incidentTimes[i - 1]);
      const m = avg(deltas);
      mtbfHours = m != null ? +(m / 3600_000).toFixed(1) : null;
    }

    // MTTR + time-to-detect
    const [mttrMinutes, intervalMs] = await Promise.all([this.mttr(days), this.effectiveSnapshotIntervalMs()]);
    const timeToDetectMinutes = intervalMs != null ? +(intervalMs / 60_000).toFixed(1) : null;

    // ── Availability + coverage ──
    let availabilityPct: number | null = null;
    let coveragePct: number | null = null;
    const expectedHours = Math.max(1, Math.floor(windowMs / 3600_000));
    try {
      const hourly = await this.prisma.availabilityRollup.findMany({
        where: { granularity: "hourly", targetType: "container", bucket: { gte: since } },
        select: { bucket: true, uptimePct: true }
      });
      if (hourly.length) {
        const a = avg(hourly.map(h => h.uptimePct));
        availabilityPct = a != null ? +a.toFixed(2) : null;
        const distinctBuckets = new Set(hourly.map(h => h.bucket.getTime())).size;
        coveragePct = +Math.min(100, (distinctBuckets / expectedHours) * 100).toFixed(1);
      }
    } catch (err: any) {
      this.log.warn(`reliability: AvailabilityRollup indisponível: ${err?.message}`);
    }
    if (availabilityPct == null) {
      // Fallback documentado (coletor recém-ligado): check pontual de Site.statusCode.
      // Cobertura honesta: 1 check efetivo vs. 1 esperado por hora da janela → baixa.
      const [sitesOnline, sitesTotal] = await Promise.all([
        this.prisma.site.count({ where: { statusCode: { lt: 400 } } }).catch(() => 0),
        this.prisma.site.count().catch(() => 0)
      ]);
      if (sitesTotal > 0) {
        availabilityPct = +((sitesOnline / sitesTotal) * 100).toFixed(1);
        coveragePct = +Math.min(100, (1 / expectedHours) * 100).toFixed(2);
      }
    }

    // ── byTarget: top alvos por downtime (ContainerStateEvent) + sites down ──
    const byTarget: Array<{
      targetType: string;
      targetKey: string;
      uptimePct: number | null;
      incidents: number | null;
      downtimeSec: number | null;
    }> = [];
    try {
      const events = await this.prisma.containerStateEvent.findMany({
        where: { ts: { gte: since } },
        orderBy: { ts: "asc" },
        select: { ts: true, toState: true, container: { select: { name: true } } }
      });
      const perContainer = new Map<string, { downtimeSec: number; incidents: number; downSince: number | null }>();
      for (const e of events) {
        const name = e.container.name;
        const s = perContainer.get(name) ?? { downtimeSec: 0, incidents: 0, downSince: null };
        if (e.toState !== "running") {
          if (s.downSince == null) {
            s.downSince = e.ts.getTime();
            s.incidents++;
          }
        } else if (s.downSince != null) {
          s.downtimeSec += (e.ts.getTime() - s.downSince) / 1000;
          s.downSince = null;
        }
        perContainer.set(name, s);
      }
      const now = Date.now();
      for (const [name, s] of perContainer) {
        if (s.downSince != null) {
          s.downtimeSec += (now - s.downSince) / 1000; // ainda down → conta até agora
          s.downSince = null;
        }
        if (s.downtimeSec > 0) {
          const windowSec = windowMs / 1000;
          byTarget.push({
            targetType: "container",
            targetKey: name,
            uptimePct: +(Math.max(0, ((windowSec - s.downtimeSec) / windowSec) * 100)).toFixed(2),
            incidents: s.incidents,
            downtimeSec: Math.round(s.downtimeSec)
          });
        }
      }
      byTarget.sort((a, b) => (b.downtimeSec ?? 0) - (a.downtimeSec ?? 0));
      byTarget.splice(10); // top 10 containers por downtime
    } catch (err: any) {
      this.log.warn(`reliability: ContainerStateEvent indisponível: ${err?.message}`);
    }
    // Sites atualmente down (5xx) entram sem série histórica (uptime null)
    try {
      const downSites = await this.prisma.site.findMany({
        where: { statusCode: { gte: 500 } },
        select: { domain: true }
      });
      for (const s of downSites) {
        byTarget.push({ targetType: "site", targetKey: s.domain, uptimePct: null, incidents: null, downtimeSec: null });
      }
    } catch {}

    // ── dailyAvailability: 1 entrada por dia da janela ──
    const dailyAvailability: Array<{ date: string; uptimePct: number | null; incidents: number | null }> = [];
    let dailyByDate = new Map<string, { pcts: number[]; incidents: number }>();
    try {
      const daily = await this.prisma.availabilityRollup.findMany({
        where: { granularity: "daily", bucket: { gte: since } },
        select: { bucket: true, uptimePct: true, incidents: true }
      });
      for (const d of daily) {
        const key = d.bucket.toISOString().slice(0, 10);
        const e = dailyByDate.get(key) ?? { pcts: [], incidents: 0 };
        e.pcts.push(d.uptimePct);
        e.incidents += d.incidents;
        dailyByDate.set(key, e);
      }
    } catch (err: any) {
      dailyByDate = new Map();
    }
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 24 * 3600_000).toISOString().slice(0, 10);
      const e = dailyByDate.get(date);
      const a = e ? avg(e.pcts) : null;
      // Sem rollup → null (o UptimeBar mostra "nodata" — nunca inventar 100%)
      dailyAvailability.push({
        date,
        uptimePct: a != null ? +a.toFixed(2) : null,
        incidents: e ? e.incidents : null
      });
    }

    return {
      windowDays: days,
      availabilityPct,
      coveragePct,
      mttrMinutes,
      timeToDetectMinutes,
      mtbfHours,
      incidentCount,
      deploySuccessRatePct,
      deploysTotal,
      byTarget,
      dailyAvailability
    };
  }

  // ─────────────────────────────────────────────────────────
  // FASE 3 — GET /analytics/health (HealthOverviewSchema)
  // ─────────────────────────────────────────────────────────

  /** Golden signals compostos + score + mostImportant. Cache Redis 20s. */
  async health() {
    return this.redis.cached("analytics:health", 20, () => this.computeHealth());
  }

  private async computeHealth() {
    const now = Date.now();
    const [last2, coolifyApps, unhealthyContainers, registrySize] = await Promise.all([
      this.prisma.hostMetricSnapshot.findMany({ orderBy: { createdAt: "desc" }, take: 2 }),
      this.coolify.listApplications().catch(() => null as any[] | null),
      this.prisma.container
        .count({ where: { monitored: true, currentHealth: "unhealthy" } })
        .catch(() => 0),
      this.prisma.container.count().catch(() => 0)
    ]);
    const latest = last2[0] ?? null;
    const prev = last2[1] ?? null;
    const latestFresh = !!latest && now - latest.createdAt.getTime() < 15 * 60_000;

    // ── saturation: pior PSI do último snapshot (limiares Fase 1 §A) ──
    const psiCpu = latest?.psiCpuSomeAvg60 ?? null;
    const psiIo = latest?.psiIoFullAvg10 ?? null;
    const psiMem = latest?.psiMemFullAvg10 ?? null;
    const psiVals = [psiCpu, psiIo, psiMem].filter((v): v is number => v != null);
    const saturation: Signal = {
      value: psiVals.length ? +Math.max(...psiVals).toFixed(1) : null,
      unit: "% PSI",
      label: "Saturação (pior PSI: cpu-some/io-full/mem-full)",
      rag:
        !latestFresh || !psiVals.length
          ? "stale"
          : worstRag(ragOf(psiCpu, 25, 75), ragOf(psiIo, 15, 25), ragOf(psiMem, 2, 5))
    };

    // ── errors: containers unhealthy + apps coolify exited ──
    const exitedApps = Array.isArray(coolifyApps)
      ? coolifyApps.filter(a => String(a?.status || "").toLowerCase().includes("exited"))
      : [];
    const unhealthyApps = Array.isArray(coolifyApps)
      ? coolifyApps.filter(
          a =>
            String(a?.status || "").toLowerCase().includes("unhealthy") &&
            !String(a?.status || "").toLowerCase().includes("exited")
        )
      : [];
    const errorsKnown = coolifyApps != null || registrySize > 0;
    const errorCount = unhealthyContainers + exitedApps.length;
    const errors: Signal = {
      value: errorsKnown ? errorCount : null,
      unit: "unhealthy",
      label: "Containers unhealthy + apps Coolify exited",
      rag: !errorsKnown ? "stale" : errorCount >= 1 ? "crit" : "ok"
    };

    // ── traffic: Kbps agregado (Δ netIn+netOut dos 2 últimos snapshots) ──
    let trafficKbps: number | null = null;
    if (latest && prev && latest.netInBytes != null && prev.netInBytes != null) {
      const dtSec = (latest.createdAt.getTime() - prev.createdAt.getTime()) / 1000;
      if (dtSec > 0) {
        const dIn = Math.max(0, Number(latest.netInBytes - prev.netInBytes));
        const dOut = Math.max(0, Number((latest.netOutBytes ?? 0n) - (prev.netOutBytes ?? 0n)));
        trafficKbps = +(((dIn + dOut) * 8) / dtSec / 1000).toFixed(1); // bytes→bits→kbit/s
      }
    }
    const traffic: Signal = {
      value: trafficKbps,
      unit: "Kbps",
      label: "Tráfego de rede do host (rx+tx)",
      rag: trafficKbps == null || !latestFresh ? "stale" : "ok"
    };

    // ── latency: média Site.responseMs dos sites online (probe sintético) ──
    let latencyMs: number | null = null;
    try {
      const sites = await this.prisma.site.findMany({
        where: { statusCode: { lt: 400 }, responseMs: { not: null } },
        select: { responseMs: true }
      });
      const a = avg(sites.map(s => s.responseMs!));
      latencyMs = a != null ? Math.round(a) : null;
    } catch {}
    const latency: Signal = {
      value: latencyMs,
      unit: "ms",
      label: "Latência média dos sites (probe sintético)",
      rag: latencyMs == null ? "stale" : ragOf(latencyMs, 500, 2000)
    };

    // ── sparks: últimas 24 amostras horárias ──
    try {
      const sparks = await this.buildSparks();
      if (sparks.saturation?.length) saturation.spark = sparks.saturation;
      if (sparks.traffic?.length) traffic.spark = sparks.traffic;
      // errors/latency: sem série histórica confiável ainda → spark omitido
    } catch (err: any) {
      this.log.warn(`health sparks: ${err?.message}`);
    }

    // ── score 0-100: 100 − penalidades ──
    let score = 100;
    for (const s of [saturation, errors, traffic, latency]) {
      if (s.rag === "warn") score -= 10;
      if (s.rag === "crit") score -= 25;
    }
    score -= errorCount * 5; // containers/apps down: −5 cada
    score = Math.max(0, Math.min(100, score));
    const scoreRag: Rag = score >= 80 ? "ok" : score >= 60 ? "warn" : "crit";

    // ── mostImportant ──
    const mostImportant = await this.pickMostImportant(exitedApps, unhealthyApps).catch(() => null);

    return {
      score,
      rag: scoreRag,
      signals: { latency, traffic, errors, saturation },
      mostImportant
    };
  }

  /** Sparks horários: cpu/PSI p/ saturation, Kbps p/ traffic (rollup → fallback snapshots). */
  private async buildSparks(): Promise<{ saturation?: number[]; traffic?: number[] }> {
    const since = new Date(Date.now() - 24 * 3600_000);
    const out: { saturation?: number[]; traffic?: number[] } = {};

    const rollups = await this.prisma.hostMetricRollup
      .findMany({
        where: { granularity: "hourly", bucket: { gte: since } },
        orderBy: { bucket: "asc" },
        select: { psiCpuSomeMax: true, cpuAvg: true }
      })
      .catch(() => []);
    if (rollups.length >= 2) {
      out.saturation = rollups.map(r => +(r.psiCpuSomeMax ?? r.cpuAvg).toFixed(1)).slice(-24);
    }

    const snaps = await this.prisma.hostMetricSnapshot.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, cpuPercent: true, netInBytes: true, netOutBytes: true }
    });
    if (!out.saturation && snaps.length >= 2) {
      // Fallback: média horária de cpuPercent
      const byHour = new Map<number, number[]>();
      for (const s of snaps) {
        const h = Math.floor(s.createdAt.getTime() / 3600_000);
        (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(s.cpuPercent);
      }
      out.saturation = Array.from(byHour.keys())
        .sort((a, b) => a - b)
        .map(h => +(avg(byHour.get(h)!) ?? 0).toFixed(1))
        .slice(-24);
    }
    if (snaps.length >= 3) {
      // Kbps por delta consecutivo, agregado por hora
      const byHour = new Map<number, number[]>();
      for (let i = 1; i < snaps.length; i++) {
        const a = snaps[i - 1];
        const b = snaps[i];
        if (a.netInBytes == null || b.netInBytes == null) continue;
        const dt = (b.createdAt.getTime() - a.createdAt.getTime()) / 1000;
        if (dt <= 0) continue;
        const dIn = Math.max(0, Number(b.netInBytes - a.netInBytes));
        const dOut = Math.max(0, Number((b.netOutBytes ?? 0n) - (a.netOutBytes ?? 0n)));
        const kbps = ((dIn + dOut) * 8) / dt / 1000;
        const h = Math.floor(b.createdAt.getTime() / 3600_000);
        (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(kbps);
      }
      const series = Array.from(byHour.keys())
        .sort((a, b) => a - b)
        .map(h => +(avg(byHour.get(h)!) ?? 0).toFixed(1))
        .slice(-24);
      if (series.length >= 2) out.traffic = series;
    }
    return out;
  }

  /**
   * mostImportant, na ordem: app exited/unhealthy → systemd failed sem recovery →
   * alerta critical nas últimas 2h → disco "dias até encher" < 30 → null.
   */
  private async pickMostImportant(
    exitedApps: any[],
    unhealthyApps: any[]
  ): Promise<{ title: string; detail: string | null; href: string; severity: string } | null> {
    // 1. App coolify exited/unhealthy
    const badApp = exitedApps[0] ?? unhealthyApps[0];
    if (badApp) {
      return {
        title: `App ${badApp.name} está ${String(badApp.status || "").toLowerCase().includes("exited") ? "exited" : "unhealthy"}`,
        detail: `Status Coolify: ${badApp.status}`,
        href: "/coolify",
        severity: "critical"
      };
    }

    // 2. Unidade systemd failed sem recovery (últimas 24h)
    try {
      const sysEvents = await this.prisma.systemdUnitEvent.findMany({
        where: { ts: { gte: new Date(Date.now() - 24 * 3600_000) } },
        orderBy: { ts: "desc" },
        take: 200,
        select: { unitName: true, activeState: true, message: true, ts: true }
      });
      const latestByUnit = new Map<string, (typeof sysEvents)[number]>();
      for (const e of sysEvents) if (!latestByUnit.has(e.unitName)) latestByUnit.set(e.unitName, e);
      const failed = Array.from(latestByUnit.values()).find(e => e.activeState === "failed");
      if (failed) {
        return {
          title: `Unidade systemd ${failed.unitName} em failed`,
          detail: failed.message ?? `failed desde ${failed.ts.toISOString()}`,
          href: "/srv1",
          severity: "critical"
        };
      }
    } catch {}

    // 3. Alerta critical ativo nas últimas 2h
    try {
      const alert = await this.prisma.alertLog.findFirst({
        where: { severity: "critical", createdAt: { gte: new Date(Date.now() - 2 * 3600_000) } },
        orderBy: { createdAt: "desc" },
        select: { title: true, message: true }
      });
      if (alert) {
        return {
          title: alert.title,
          detail: alert.message?.slice(0, 160) ?? null,
          href: "/alerts",
          severity: "critical"
        };
      }
    } catch {}

    // 4. Disco: regressão linear simples de diskUsedGb (amostras diárias, 14d)
    try {
      const days = await this.diskDaysToFull();
      if (days != null && days < 30) {
        return {
          title: `Disco enche em ~${Math.max(0, Math.round(days))} dia(s)`,
          detail: "Projeção linear do crescimento de diskUsedGb nos últimos 14 dias",
          href: "/srv1",
          severity: days < 7 ? "critical" : "warning"
        };
      }
    } catch {}

    return null;
  }

  /** Regressão linear (GB/dia) sobre médias diárias de diskUsedGb dos últimos 14d. */
  private async diskDaysToFull(): Promise<number | null> {
    const since = new Date(Date.now() - 14 * 24 * 3600_000);
    const snaps = await this.prisma.hostMetricSnapshot.findMany({
      where: { createdAt: { gte: since }, diskUsedGb: { not: null } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true, diskUsedGb: true, diskTotalGb: true }
    });
    if (snaps.length < 4) return null;
    // Média por dia (x em dias desde o início)
    const byDay = new Map<number, number[]>();
    for (const s of snaps) {
      const d = Math.floor(s.createdAt.getTime() / 86_400_000);
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(s.diskUsedGb!);
    }
    const points = Array.from(byDay.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([d, vals]) => ({ x: d, y: avg(vals)! }));
    if (points.length < 3) return null;
    const n = points.length;
    const x0 = points[0].x;
    const xs = points.map(p => p.x - x0);
    const ys = points.map(p => p.y);
    const xMean = avg(xs)!;
    const yMean = avg(ys)!;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (xs[i] - xMean) * (ys[i] - yMean);
      den += (xs[i] - xMean) ** 2;
    }
    if (den === 0) return null;
    const slopeGbPerDay = num / den;
    if (slopeGbPerDay <= 0.01) return null; // estável/encolhendo → sem previsão
    const lastUsed = ys[ys.length - 1];
    const total = snaps[snaps.length - 1].diskTotalGb;
    if (!total) return null;
    return (total - lastUsed) / slopeGbPerDay;
  }
}
