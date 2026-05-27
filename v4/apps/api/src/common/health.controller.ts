import { Controller, Get } from "@nestjs/common";
import { PrismaService } from "./prisma.service";
import { RedisService } from "./redis.service";

@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  @Get("health")
  async health() {
    const db = await this.prisma.$queryRawUnsafe("SELECT 1 as ok").then(() => "ok").catch(() => "down");
    const redis = await this.redis.client.ping().then(() => "ok").catch(() => "down");
    const all = db === "ok" && redis === "ok";
    return {
      version: "4.0.0",
      status: all ? "ok" : "degraded",
      timestamp: new Date().toISOString(),
      services: { db, redis }
    };
  }

  @Get("/")
  root() {
    return { service: "controler-v4-api", docs: "/api/docs" };
  }
}
