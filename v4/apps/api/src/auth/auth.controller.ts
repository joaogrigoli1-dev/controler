import { Body, Controller, Get, Post, Req, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { JwtAuthGuard, AuthUser } from "./jwt-auth.guard";
import { RequestCodeSchema, VerifyCodeSchema } from "@controler/shared";

function getIp(req: any): string {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
}

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("request-code")
  async requestCode(@Body() body: any, @Req() req: any) {
    const parsed = RequestCodeSchema.parse(body);
    return this.auth.requestCode(parsed.phone, getIp(req));
  }

  @Post("verify-code")
  async verifyCode(@Body() body: any, @Req() req: any) {
    const parsed = VerifyCodeSchema.parse(body);
    return this.auth.verifyCode(parsed.phone, parsed.code, getIp(req), req.headers["user-agent"] || "");
  }

  @Post("refresh")
  async refresh(@Body() body: { refreshToken: string }, @Req() req: any) {
    return this.auth.refresh(body.refreshToken, getIp(req));
  }

  @UseGuards(JwtAuthGuard)
  @Post("logout")
  async logout(@AuthUser() user: any) {
    return this.auth.logout(user.id);
  }

  @UseGuards(JwtAuthGuard)
  @Post("reauth/request")
  async reauthRequest(@AuthUser() user: any, @Req() req: any) {
    return this.auth.issueReauthCode(user.id, getIp(req));
  }

  @UseGuards(JwtAuthGuard)
  @Get("me")
  me(@AuthUser() user: any) {
    return { user };
  }
}
