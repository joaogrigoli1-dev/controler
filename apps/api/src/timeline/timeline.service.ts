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
    const now = Date.now();
    const since = new Date(now - 24 * 3600_000);
    const events = await this.prisma.timelineEvent.findMany({
      where: { createdAt: { gte: since } },
      select: { createdAt: true, severity: true }
    });

    // 24 buckets contínuos, mais antigo (-24h) ao mais novo (-0h).
    // Cada bucket é um Date object com a hora-cheia BRT (UTC-3).
    // Chave: "HHh-DD" (ex: "14h-27") para garantir unicidade quando atravessa dias.
    const TZ_OFFSET_MS = -3 * 3600_000; // BRT (UTC-3); ajustar se mudar de fuso
    const buckets: Array<{ key: string; hour: number; info: number; warning: number; critical: number }> = [];
    for (let h = 23; h >= 0; h--) {
      const ts = new Date(now - h * 3600_000 + TZ_OFFSET_MS);
      const hh = ts.getUTCHours(); // como já ajustamos offset, getUTCHours = hora BRT
      buckets.push({ key: `${hh.toString().padStart(2, "0")}h`, hour: hh, info: 0, warning: 0, critical: 0 });
    }

    events.forEach(e => {
      const eventTime = new Date(e.createdAt).getTime();
      const hoursAgo = Math.floor((now - eventTime) / 3600_000);
      if (hoursAgo < 0 || hoursAgo > 23) return;
      const idx = 23 - hoursAgo;
      const sev = e.severity as "info" | "warning" | "critical";
      if (buckets[idx] && (sev === "info" || sev === "warning" || sev === "critical")) {
        buckets[idx][sev]++;
      }
    });

    // Retorna como objeto chaveado para retrocompat com frontend
    return buckets.reduce((acc, b) => {
      acc[b.key] = { info: b.info, warning: b.warning, critical: b.critical };
      return acc;
    }, {} as Record<string, { info: number; warning: number; critical: number }>);
  }
}
