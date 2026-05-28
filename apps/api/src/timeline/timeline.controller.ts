import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { TimelineService } from "./timeline.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("timeline")
export class TimelineController {
  constructor(private readonly svc: TimelineService) {}

  @Get()
  list(
    @Query("severity") severity?: string,
    @Query("project") project?: string,
    @Query("limit") limit?: string,
    @Query("cursor") cursor?: string
  ) {
    return this.svc.list({
      severity,
      project,
      limit: limit ? parseInt(limit, 10) : 50,
      cursor
    });
  }

  @Get("heatmap")
  heatmap() {
    return this.svc.heatmap24h();
  }
}
