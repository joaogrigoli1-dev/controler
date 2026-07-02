/**
 * AnalyticsService — KPIs agregados do NOC, MTTR/MTBF, tendências, distribuições.
 *
 * Estendido em 2026-06-04: 12+ KPIs ao invés dos 4 originais (deploys, alertas,
 * críticos, MTTR). Agora cobre: uptime do host, success-rate de deploys, distribuição
 * de severidade, throughput de scanner, sites uptime, alertas por canal e top
 * containers por CPU/RAM nas últimas 24h.
 */

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";
import { HOST_METRICS_INTERVAL_MS } from "../realtime/metrics.scheduler";

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

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
   * MTTR: do FAIL ao próximo SUCCESS, mesmo projeto. Retorna minutos médios.
   */
  async mttr(days: number): Promise<number | null> {
    const since = new Date(Date.now() - days * 24 * 3600_000);
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

  async containerMetricsHistory(name: string, hours = 24) {
    const since = new Date(Date.now() - hours * 3600_000);
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
   * Uptime do host nas últimas N horas = cobertura de snapshots.
   * Cada tick grava 1 snapshot; se o coletor (ou o host) esteve fora, faltam snapshots.
   * Fase 2 (Gap #4): o "esperado" deriva do intervalo REAL do scheduler
   * (HOST_METRICS_INTERVAL_MS), não do hardcode 60/h — que reportava ~20% com host 100% são.
   */
  async hostUptimePercent(hours = 24): Promise<{ uptimePercent: number; samples: number; expected: number }> {
    const since = new Date(Date.now() - hours * 3600_000);
    const samples = await this.prisma.hostMetricSnapshot.count({
      where: { createdAt: { gte: since } }
    });
    const perHour = 3600_000 / HOST_METRICS_INTERVAL_MS; // ex.: 300_000ms → 12/h
    const expected = Math.max(1, Math.round(hours * perHour));
    const ratio = Math.min(100, (samples / expected) * 100);
    return { uptimePercent: +ratio.toFixed(1), samples, expected };
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
}
