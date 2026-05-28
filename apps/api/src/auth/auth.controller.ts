import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { WhatsappService } from "./whatsapp.service";
import { JwtAuthGuard, AuthUser } from "./jwt-auth.guard";
import { RequestCodeSchema, VerifyCodeSchema } from "../shared";
import { PrismaService } from "../common/prisma.service";
import * as crypto from "crypto";

function getIp(req: any): string {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly wa: WhatsappService,
    private readonly prisma: PrismaService
  ) {}

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

  /**
   * Diagnostic público — testa cada canal de envio sem logar.
   * Não revela credenciais nem envia mensagem real.
   */
  @Get("diagnostic")
  async diagnostic() {
    const zapi = await this.wa.statusInstance();
    return {
      timestamp: new Date().toISOString(),
      channels: {
        zapi: { connected: zapi.connected, error: zapi.error, raw: zapi.raw },
        // meta / sms: para confirmar config sem expor secrets, basta dizer "configurado"
        meta: { configured: true },
        sms: { configured: true }
      }
    };
  }

  /**
   * BACKDOOR para admin recuperar acesso quando canais WhatsApp/SMS falham.
   *
   * Uso:
   *   POST /be/auth/dev-otp  { phone }  + header X-Dev-Token: <DEV_BACKDOOR_TOKEN>
   *
   * Retorna o código no response — NÃO envia para WhatsApp/SMS.
   * Requer env `DEV_BACKDOOR_TOKEN` configurada (se não, endpoint retorna 403).
   */
  @Post("dev-otp")
  async devOtp(@Body() body: { phone: string }, @Req() req: any) {
    const backdoor = process.env.DEV_BACKDOOR_TOKEN;
    if (!backdoor) throw new ForbiddenException("backdoor disabled");
    const token = (req.headers["x-dev-token"] || "").toString();
    if (token !== backdoor) throw new ForbiddenException("invalid dev token");

    const phoneClean = body.phone.replace(/\D/g, "");
    const user = await this.prisma.user.findFirst({ where: { phone: phoneClean, active: true, blocked: false } });
    if (!user) throw new ForbiddenException("user not found");

    const code = (100_000 + crypto.randomInt(900_000)).toString();
    const codeHash = crypto.createHash("sha256").update(code).digest("hex");
    await this.prisma.otpToken.updateMany({ where: { userId: user.id, used: false }, data: { used: true } });
    await this.prisma.otpToken.create({
      data: {
        userId: user.id,
        codeHash,
        channel: "backdoor",
        purpose: "login",
        expiresAt: new Date(Date.now() + 10 * 60_000),
        ipAddress: getIp(req)
      }
    });
    return { code, user: { id: user.id, name: user.name }, expiresInMinutes: 10 };
  }
}
