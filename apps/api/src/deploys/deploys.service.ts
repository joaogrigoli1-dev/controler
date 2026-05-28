import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class DeploysService {
  constructor(private readonly prisma: PrismaService) {}

  history(project?: string, limit = 50) {
    return this.prisma.deployHistory.findMany({
      where: project ? { project } : undefined,
      orderBy: { startedAt: "desc" },
      take: limit
    });
  }

  record(d: { project: string; coolifyUuid?: string; status: string; commitSha?: string; commitMsg?: string; branch?: string; author?: string; durationSec?: number; triggeredBy?: string; startedAt: Date; finishedAt?: Date }) {
    return this.prisma.deployHistory.create({ data: d });
  }

  async stats(days = 30) {
    const since = new Date(Date.now() - days * 24 * 3600_000);
    const rows = await this.prisma.deployHistory.findMany({
      where: { startedAt: { gte: since } },
      select: { project: true, status: true, durationSec: true }
    });
    const byProject: Record<string, { total: number; success: number; failed: number; avgDuration: number }> = {};
    for (const r of rows) {
      const b = byProject[r.project] ?? { total: 0, success: 0, failed: 0, avgDuration: 0 };
      b.total++;
      if (r.status === "success") b.success++;
      if (r.status === "failed") b.failed++;
      if (r.durationSec) b.avgDuration = (b.avgDuration * (b.total - 1) + r.durationSec) / b.total;
      byProject[r.project] = b;
    }
    return byProject;
  }
}
