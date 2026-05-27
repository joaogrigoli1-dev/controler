import { Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApisService } from "./apis.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("apis")
export class ApisController {
  constructor(private readonly svc: ApisService) {}

  @Get()
  list(@Query("project") project?: string) {
    return this.svc.listByProject(project);
  }

  @Post("ping")
  ping() {
    return this.svc.pingAll();
  }
}
