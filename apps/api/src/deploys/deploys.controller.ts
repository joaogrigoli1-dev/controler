import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { DeploysService } from "./deploys.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("deploys")
export class DeploysController {
  constructor(private readonly svc: DeploysService) {}

  @Get()
  history(@Query("project") project?: string, @Query("limit") limit?: string) {
    return this.svc.history(project, limit ? parseInt(limit, 10) : 50);
  }

  @Get("stats")
  stats(@Query("days") days?: string) {
    return this.svc.stats(days ? parseInt(days, 10) : 30);
  }
}
