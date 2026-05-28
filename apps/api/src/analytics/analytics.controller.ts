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

  @Get("host/history")
  host(@Query("hours") hours?: string) {
    return this.svc.hostMetricsHistory(hours ? parseInt(hours, 10) : 24);
  }

  @Get("containers/:name/history")
  container(@Param("name") name: string, @Query("hours") hours?: string) {
    return this.svc.containerMetricsHistory(name, hours ? parseInt(hours, 10) : 24);
  }
}
