import { Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ScannerService } from "./scanner.service";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { OtpReauthGuard } from "../auth/otp-reauth.guard";

@UseGuards(JwtAuthGuard)
@Controller("scanner")
export class ScannerController {
  constructor(private readonly svc: ScannerService) {}

  @Post("run")
  run() {
    return this.svc.runAll();
  }

  @Get("findings")
  list(@Query("resolved") resolved?: string) {
    return this.svc.listFindings(resolved === "true");
  }

  @UseGuards(OtpReauthGuard)
  @Post("findings/:id/fix")
  fix(@Param("id") id: string) {
    return this.svc.executeSafeAction(id);
  }
}
