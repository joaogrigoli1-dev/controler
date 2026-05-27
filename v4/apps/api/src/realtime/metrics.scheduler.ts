/**
 * MetricsScheduler — jobs APScheduler-equivalentes:
 *   - host metrics: a cada 30s, snapshot + emit WS
 *   - container metrics: a cada 30s
 *   - daily digest: 8h BRT
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression, Interval } from "@nestjs/schedule";
import { Srv1Service } from "../srv1/srv1.service";
import { PrismaService } from "../common/prisma.service";
import { RealtimeGateway } from "./realtime.gateway";

@Injectable()
export class MetricsScheduler {
  private readonly log = new Logger("Scheduler");

  constructor(
    private readonly srv1: Srv1Service,
    private readonly prisma: PrismaService,
    private readonly gw: RealtimeGateway
  ) {}

  @Interval("host-metrics", 30_000)
  async hostMetricsTick() {
    try {
      const m = await this.srv1.getHostMetrics();
      await this.prisma.hostMetricSnapshot.create({
        data: {
          cpuPercent: m.cpuPercent,
          loadAvg1m: m.loadAvg[0], loadAvg5m: m.loadAvg[1], loadAvg15m: m.loadAvg[2],
          memTotalMb: m.memTotalMb, memUsedMb: m.memUsedMb,
          diskTotalGb: m.diskTotalGb, diskUsedGb: m.diskUsedGb,
          swapUsedMb: m.swapUsedMb,
          netInBytes: BigInt(m.netInBytes || 0), netOutBytes: BigInt(m.netOutBytes || 0)
        }
      });
      this.gw.emitHostMetrics({ ...m, ts: Date.now() });
    } catch (err: any) {
      this.log.warn(`host metrics failed: ${err?.message}`);
    }
  }

  @Interval("container-metrics", 30_000)
  async containerMetricsTick() {
    try {
      const containers = await this.srv1.getContainers();
      const rows = containers.map(c => ({
        containerName: c.name,
        cpuPercent: c.cpuPercent,
        memMb: c.memMb,
        memPercent: c.memPercent
      }));
      if (rows.length) {
        await this.prisma.metricSnapshot.createMany({ data: rows });
      }
      this.gw.emitContainerMetrics({ containers, ts: Date.now() });
    } catch (err: any) {
      this.log.warn(`container metrics failed: ${err?.message}`);
    }
  }

  @Cron("0 8 * * *", { timeZone: "America/Sao_Paulo" })
  async dailyDigest() {
    try {
      const containers = await this.srv1.getContainers().catch(() => []);
      const host = await this.srv1.getHostMetrics().catch(() => null);
      this.log.log(`Daily digest: ${containers.length} containers, host=${host?.cpuPercent}%cpu`);
      // TODO: chamar AlertsService.dispatch via forwardRef se ativo
    } catch (err: any) {
      this.log.warn(`daily digest failed: ${err?.message}`);
    }
  }

  // limpeza diária: snapshots > 30 dias
  @Cron("0 3 * * *", { timeZone: "America/Sao_Paulo" })
  async cleanup() {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600_000);
    const [m, h] = await Promise.all([
      this.prisma.metricSnapshot.deleteMany({ where: { createdAt: { lt: cutoff } } }),
      this.prisma.hostMetricSnapshot.deleteMany({ where: { createdAt: { lt: cutoff } } })
    ]);
    this.log.log(`Cleanup: removed ${m.count + h.count} old snapshots`);
  }
}
