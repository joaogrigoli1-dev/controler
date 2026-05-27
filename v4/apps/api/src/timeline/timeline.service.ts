import { Injectable } from "@nestjs/common";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class TimelineService {
  constructor(private readonly prisma: PrismaService) {}

  list(filter?: { severity?: string; project?: string; limit?: number; cursor?: string }) {
    return this.prisma.timelineEvent.findMany({
      where: { severity: filter?.severity, project: filter?.project },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 50,
      cursor: filter?.cursor ? { id: filter.cursor } : undefined,
      skip: filter?.cursor ? 1 : 0
    });
  }

  async log(args: { eventType: string; title: string; severity?: string; project?: string; detail?: string; actor: string; metadata?: any }) {
    return this.prisma.timelineEvent.create({
      data: { ...args, severity: args.severity || "info" }
    });
  }

  async heatmap24h() {
    const since = new Date(Date.now() - 24 * 3600_000);
    const events = await this.prisma.timelineEvent.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, severity: true }
    });
    // Agrupa por hora
    const buckets: Record<string, { info: number; warning: number; critical: number }> = {};
    for (let h = 0; h < 24; h++) {
      const ts = new Date(Date.now() - (23 - h) * 3600_000);
      const key = `${ts.getHours()}h`;
      buckets[key] = { info: 0, warning: 0, critical: 0 };
    }
    events.forEach(e => {
      const key = `${new Date(e.createdAt).getHours()}h`;
      if (buckets[key]) buckets[key][e.severity as "info" | "warning" | "critical"]++;
    });
    return buckets;
  }
}
