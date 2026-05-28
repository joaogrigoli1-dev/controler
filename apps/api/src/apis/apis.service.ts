import { Injectable } from "@nestjs/common";
import axios from "axios";
import { PrismaService } from "../common/prisma.service";

@Injectable()
export class ApisService {
  constructor(private readonly prisma: PrismaService) {}

  listByProject(projectSlug?: string) {
    return this.prisma.projectApi.findMany({
      where: projectSlug ? { project: { slug: projectSlug } } : undefined,
      include: { project: { select: { slug: true, name: true, icon: true } } },
      orderBy: { name: "asc" }
    });
  }

  async pingAll() {
    const apis = await this.prisma.projectApi.findMany({ where: { healthUrl: { not: null } } });
    const results = await Promise.all(apis.map(async (api) => {
      const t0 = Date.now();
      try {
        const r = await axios.get(api.healthUrl!, { timeout: 8_000, validateStatus: () => true });
        const responseTimeMs = Date.now() - t0;
        const status = r.status < 400 ? "healthy" : r.status < 500 ? "degraded" : "down";
        await this.prisma.projectApi.update({
          where: { id: api.id },
          data: { status, responseTimeMs, lastChecked: new Date() }
        });
        return { id: api.id, name: api.name, status, responseTimeMs };
      } catch (err: any) {
        await this.prisma.projectApi.update({
          where: { id: api.id },
          data: { status: "down", lastChecked: new Date() }
        });
        return { id: api.id, name: api.name, status: "down", error: err?.message };
      }
    }));
    return results;
  }
}
