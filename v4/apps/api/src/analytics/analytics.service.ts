/**
 * AnalyticsService — MTTR/MTBF, tendências, comparativos 7/30/90d.
 */

import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overviewKpis(periodDays = 7) {
    const since = new Date(Date.now() - periodDays * 24 * 3600_000);
    const prevSince = new Date(Date.now() - 2 * periodDays * 24 * 3600_000);

    const [deploys, deploysPrev, alerts, alertsPrev, criticalNow, mttr] = await Promise.all([
      this.prisma.deployHistory.count({ where: { startedAt: { gte: since } } }),
      this.prisma.deployHistory.count({ where: { startedAt: { gte: prevSince, lt: since } } }),
      this.prisma.alertLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.alertLog.count({ where: { createdAt: { gte: prevSince, lt: since } } }),
      this.prisma.alertLog.count({ where: { severity: "critical", createdAt: { gte: since } } }),
      this.mttr(periodDays)
    ]);

    return {
      periodDays,
      deploys: { current: deploys, previous: deploysPrev, delta: deploys - deploysPrev },
      alerts: { current: alerts, previous: alertsPrev, delta: alerts - alertsPrev, critical: criticalNow },
      mttrMinutes: mttr
    };
  }

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
      select: { createdAt: true, cpuPercent: true, memUsedMb: true, memTotalMb: true, diskUsedGb: true, diskTotalGb: true, loadAvg5m: true }
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
}
