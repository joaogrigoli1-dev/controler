import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AlertsService } from "./alerts.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("alerts")
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  recent(@Query("limit") limit?: string) {
    return this.svc.recentLogs(limit ? parseInt(limit, 10) : 100);
  }

  @Get("summary")
  summary() {
    return this.svc.summary();
  }

  @Get("rules")
  rules() {
    return this.svc.listRules();
  }

  @Post("rules")
  createRule(@Body() body: any) {
    return this.svc.createRule(body);
  }

  @Put("rules/:id")
  updateRule(@Param("id") id: string, @Body() body: any) {
    return this.svc.updateRule(id, body);
  }

  @Delete("rules/:id")
  deleteRule(@Param("id") id: string) {
    return this.svc.deleteRule(id);
  }

  @Post("rules/:id/silence")
  silenceRule(@Param("id") id: string, @Body() body: { hours: number }) {
    return this.svc.silenceRule(id, body.hours ?? 1);
  }

  @Post("test")
  test(@Body() body: { severity?: "info" | "warning" | "critical"; title?: string; message?: string }) {
    return this.svc.dispatch({
      ruleKey: `manual-test-${Date.now()}`,
      severity: body.severity || "warning",
      title: body.title || "Alerta de teste",
      message: body.message || "Disparado manualmente do painel"
    });
  }
}
