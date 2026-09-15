import { Body, Controller, Get, Inject, Post, Query, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SincIngestGuard } from "./sinc-ingest.guard";
import { SincService } from "./sinc.service";

@Controller()
export class SincController {
  constructor(@Inject(SincService) private readonly service: SincService) {}

  @Post("v1/roteador/events/batch")
  @UseGuards(SincIngestGuard)
  ingest(@Body() body: unknown) { return this.service.ingest(body); }

  @Get("sinc/dashboard")
  @UseGuards(JwtAuthGuard)
  dashboard(@Query() query: Record<string, unknown>) {
    // Fastify query dictionaries have a null prototype; validate their keys as data.
    return this.service.dashboard({ ...query });
  }
}
