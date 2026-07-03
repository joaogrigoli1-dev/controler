import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AlertsService } from "./alerts.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { RolesGuard } from "../auth/roles.guard";
import { Roles } from "../auth/roles.decorator";

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

  // E5: mutações de regras + disparo de teste restritos a admin (JwtAuthGuard é
  // class-level e roda antes; RolesGuard depende de req.user preenchido por ele)
  @Roles("admin")
  @UseGuards(RolesGuard)
  @Post("rules")
  createRule(@Body() body: any) {
    return this.svc.createRule(body);
  }

  @Roles("admin")
  @UseGuards(RolesGuard)
  @Put("rules/:id")
  updateRule(@Param("id") id: string, @Body() body: any) {
    return this.svc.updateRule(id, body);
  }

  @Roles("admin")
  @UseGuards(RolesGuard)
  @Delete("rules/:id")
  deleteRule(@Param("id") id: string) {
    return this.svc.deleteRule(id);
  }

  @Roles("admin")
  @UseGuards(RolesGuard)
  @Post("rules/:id/silence")
  silenceRule(@Param("id") id: string, @Body() body: { hours: number }) {
    return this.svc.silenceRule(id, body.hours ?? 1);
  }

  @Roles("admin")
  @UseGuards(RolesGuard)
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
