/**
 * PurgeService — FASE 3: retenção das séries temporais.
 *
 * @Cron 03:45 America/Sao_Paulo (madrugada, fora de horário de pico):
 *   - RAW (10 dias):    ContainerMetricPoint, HostDiskIoPoint, HostProcessSample
 *   - Rollup horário:   > 90 dias  (ContainerMetricRollup, HostMetricRollup, AvailabilityRollup)
 *   - Rollup diário:    > 400 dias (idem)
 *   - SslCheckHistory:  > 180 dias
 *
 * Nota sobre lotes: deleteMany do Prisma não aceita `take`, então o delete é
 * direto por `ts < cutoff` — o volume diário é pequeno (purge roda todo dia,
 * então cada execução remove ~1 dia de dados vencidos, nunca uma montanha).
 * Tudo com try/catch + Logger — o job nunca derruba o app.
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma.service";

const DAY_MS = 24 * 3600_000;
const RAW_RETENTION_DAYS = 10;
const HOURLY_RETENTION_DAYS = 90;
const DAILY_RETENTION_DAYS = 400;
const SSL_RETENTION_DAYS = 180;

@Injectable()
export class PurgeService {
  private readonly log = new Logger("Purge");

  constructor(private readonly prisma: PrismaService) {}

  @Cron("45 3 * * *", { name: "purge-retention", timeZone: "America/Sao_Paulo" })
  async tick() {
    const rawCutoff = new Date(Date.now() - RAW_RETENTION_DAYS * DAY_MS);
    const hourlyCutoff = new Date(Date.now() - HOURLY_RETENTION_DAYS * DAY_MS);
    const dailyCutoff = new Date(Date.now() - DAILY_RETENTION_DAYS * DAY_MS);
    const sslCutoff = new Date(Date.now() - SSL_RETENTION_DAYS * DAY_MS);

    await this.purge("ContainerMetricPoint (raw 10d)", () =>
      this.prisma.containerMetricPoint.deleteMany({ where: { ts: { lt: rawCutoff } } })
    );
    await this.purge("HostDiskIoPoint (raw 10d)", () =>
      this.prisma.hostDiskIoPoint.deleteMany({ where: { ts: { lt: rawCutoff } } })
    );
    await this.purge("HostProcessSample (raw 10d)", () =>
      this.prisma.hostProcessSample.deleteMany({ where: { ts: { lt: rawCutoff } } })
    );

    await this.purge("ContainerMetricRollup horário >90d", () =>
      this.prisma.containerMetricRollup.deleteMany({
        where: { granularity: "hourly", bucket: { lt: hourlyCutoff } }
      })
    );
    await this.purge("ContainerMetricRollup diário >400d", () =>
      this.prisma.containerMetricRollup.deleteMany({
        where: { granularity: "daily", bucket: { lt: dailyCutoff } }
      })
    );
    await this.purge("HostMetricRollup horário >90d", () =>
      this.prisma.hostMetricRollup.deleteMany({
        where: { granularity: "hourly", bucket: { lt: hourlyCutoff } }
      })
    );
    await this.purge("HostMetricRollup diário >400d", () =>
      this.prisma.hostMetricRollup.deleteMany({
        where: { granularity: "daily", bucket: { lt: dailyCutoff } }
      })
    );
    await this.purge("AvailabilityRollup horário >90d", () =>
      this.prisma.availabilityRollup.deleteMany({
        where: { granularity: "hourly", bucket: { lt: hourlyCutoff } }
      })
    );
    await this.purge("AvailabilityRollup diário >400d", () =>
      this.prisma.availabilityRollup.deleteMany({
        where: { granularity: "daily", bucket: { lt: dailyCutoff } }
      })
    );

    await this.purge("SslCheckHistory >180d", () =>
      this.prisma.sslCheckHistory.deleteMany({ where: { checkedAt: { lt: sslCutoff } } })
    );
  }

  private async purge(label: string, fn: () => Promise<{ count: number }>) {
    try {
      const { count } = await fn();
      if (count > 0) this.log.log(`purge ${label}: ${count} linha(s)`);
    } catch (err: any) {
      this.log.warn(`purge ${label} falhou: ${err?.message}`);
    }
  }
}
