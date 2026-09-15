import { Body, Controller, Get, Inject, Post, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SincIngestGuard } from "../sinc/sinc-ingest.guard";
import { RoteadorDashboardService } from "./roteador-dashboard.service";

@Controller()
export class RoteadorController {
  constructor(@Inject(RoteadorDashboardService) private readonly service: RoteadorDashboardService) {}

  @Get("roteador/dashboard")
  @UseGuards(JwtAuthGuard)
  dashboard() { return this.service.dashboard(); }

  @Post("v1/roteador/dashboard-supplements/batch")
  @UseGuards(SincIngestGuard)
  ingestSupplements(@Body() body: unknown) { return this.service.ingestSupplements(body); }
}
