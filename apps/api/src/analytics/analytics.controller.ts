import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { AnalyticsService } from "./analytics.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("analytics")
export class AnalyticsController {
  constructor(private readonly svc: AnalyticsService) {}

  @Get("overview")
  overview(@Query("days") days?: string) {
    return this.svc.overviewKpis(days ? parseInt(days, 10) : 7);
  }

  /** FASE 3 — contrato ReliabilitySchema (apps/web/lib/schemas.ts). */
  @Get("reliability")
  reliability(@Query("days") days?: string) {
    return this.svc.reliability(days ? parseInt(days, 10) : 30);
  }

  /** FASE 3 — contrato HealthOverviewSchema (golden signals, cache 20s). */
  @Get("health")
  health() {
    return this.svc.health();
  }

  @Get("host/history")
  host(@Query("hours") hours?: string) {
    return this.svc.hostMetricsHistory(hours ? parseInt(hours, 10) : 24);
  }

  @Get("host/uptime")
  uptime(@Query("hours") hours?: string) {
    return this.svc.hostUptimePercent(hours ? parseInt(hours, 10) : 24);
  }

  @Get("containers/:name/history")
  container(@Param("name") name: string, @Query("hours") hours?: string) {
    return this.svc.containerMetricsHistory(name, hours ? parseInt(hours, 10) : 24);
  }

  @Get("containers/top")
  topContainers(
    @Query("by") by?: "cpu" | "mem",
    @Query("hours") hours?: string,
    @Query("limit") limit?: string
  ) {
    return this.svc.topContainersByResource(
      by === "mem" ? "mem" : "cpu",
      hours ? parseInt(hours, 10) : 24,
      limit ? parseInt(limit, 10) : 10
    );
  }

  @Get("alerts/breakdown")
  alertsBreakdown(@Query("hours") hours?: string) {
    return this.svc.alertsBreakdown(hours ? parseInt(hours, 10) : 24);
  }
}
