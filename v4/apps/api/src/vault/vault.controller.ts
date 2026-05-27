import { Body, Controller, Get, Post, Query, Req, UseGuards } from "@nestjs/common";
import { VaultService } from "./vault.service";
import { JwtAuthGuard, AuthUser } from "../auth/jwt-auth.guard";
import { OtpReauthGuard } from "../auth/otp-reauth.guard";

function getIp(req: any): string {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
}

@UseGuards(JwtAuthGuard)
@Controller("vault")
export class VaultController {
  constructor(private readonly vault: VaultService) {}

  @Get("params")
  list(@Query("project") project?: string) {
    return this.vault.listByProject(project ? `/${project}` : undefined);
  }

  @UseGuards(OtpReauthGuard)
  @Post("reveal")
  reveal(@Body() body: { name: string }, @AuthUser() user: any, @Req() req: any) {
    return this.vault.reveal(body.name, user.id, getIp(req), req.headers["user-agent"]);
  }

  @Get("audit")
  audit(@Query("userId") userId?: string, @Query("resource") resource?: string, @Query("limit") limit?: string) {
    return this.vault.auditLog({
      userId,
      resource,
      limit: limit ? parseInt(limit, 10) : 100
    });
  }
}
