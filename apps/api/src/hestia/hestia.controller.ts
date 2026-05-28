import { Controller, Get, UseGuards } from "@nestjs/common";
import { HestiaService } from "./hestia.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

@UseGuards(JwtAuthGuard)
@Controller("hestia")
export class HestiaController {
  constructor(private readonly svc: HestiaService) {}

  @Get("sites")
  sites() {
    return this.svc.listSites();
  }

  @Get("mail")
  mail() {
    return this.svc.mailStackStatus();
  }
}
