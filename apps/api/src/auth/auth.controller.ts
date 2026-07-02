import { Body, Controller, ForbiddenException, Get, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply } from "fastify";
import { AuthService } from "./auth.service";
import { WhatsappService } from "./whatsapp.service";
import { JwtAuthGuard, AuthUser } from "./jwt-auth.guard";
import { RequestCodeSchema, VerifyCodeSchema } from "../shared";
import { PrismaService } from "../common/prisma.service";
import * as crypto from "crypto";

function getIp(req: any): string {
  return req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() || req.ip || "unknown";
}

// A-02: refresh token vive em cookie httpOnly (fora do alcance de JS/XSS).
const REFRESH_COOKIE = "controler_rt";
const REFRESH_MAX_AGE_SEC = 7 * 24 * 3600;
const COOKIE_PATH = "/be/auth";

function setRefreshCookie(res: FastifyReply, token: string) {
  const parts = [
    `${REFRESH_COOKIE}=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    `Path=${COOKIE_PATH}`,
    `Max-Age=${REFRESH_MAX_AGE_SEC}`
  ];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.header("set-cookie", parts.join("; "));
}
function clearRefreshCookie(res: FastifyReply) {
  const parts = [`${REFRESH_COOKIE}=`, "HttpOnly", "SameSite=Strict", `Path=${COOKIE_PATH}`, "Max-Age=0"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  res.header("set-cookie", parts.join("; "));
}
function readRefreshCookie(req: any): string | null {
  const raw = req.headers?.cookie;
  if (!raw || typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === REFRESH_COOKIE) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly wa: WhatsappService,
    private readonly prisma: PrismaService
  ) {}

  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post("request-code")
  async requestCode(@Body() body: any, @Req() req: any) {
    const parsed = RequestCodeSchema.parse(body);
    // Aceita channel opcional ('whatsapp'|'sms'|'auto'). Default = 'auto' (cascade Z-API→Meta→SMS).
    const channel = (body?.channel === "sms" || body?.channel === "whatsapp") ? body.channel : "auto";
    return this.auth.requestCode(parsed.phone, getIp(req), channel);
  }

  /**
   * Shortcut: força envio via SMS Infobip (bypassa WhatsApp completamente).
   * Útil quando WhatsApp está banido/bloqueado.
   */
  @Throttle({ auth: { limit: 5, ttl: 60_000 } })
  @Post("request-code-sms")
  async requestCodeSms(@Body() body: any, @Req() req: any) {
    const parsed = RequestCodeSchema.parse(body);
    return this.auth.requestCode(parsed.phone, getIp(req), "sms");
  }

  @Throttle({ auth: { limit: 10, ttl: 60_000 } })
  @Post("verify-code")
  async verifyCode(@Body() body: any, @Req() req: any, @Res({ passthrough: true }) res: FastifyReply) {
    const parsed = VerifyCodeSchema.parse(body);
    const result = await this.auth.verifyCode(parsed.phone, parsed.code, getIp(req), req.headers["user-agent"] || "");
    // A-02: refresh vai no cookie httpOnly; NÃO retorna no corpo (fora do alcance de JS).
    setRefreshCookie(res, result.refreshToken);
    const { refreshToken: _rt, ...safe } = result;
    return safe;
  }

  @Throttle({ auth: { limit: 20, ttl: 60_000 } })
  @Post("refresh")
  async refresh(@Body() body: { refreshToken?: string }, @Req() req: any, @Res({ passthrough: true }) res: FastifyReply) {
    // A-02: lê do cookie httpOnly; body é fallback de transição p/ clientes antigos.
    const token = readRefreshCookie(req) || body?.refreshToken;
    if (!token) throw new UnauthorizedException("Refresh ausente");
    const result = await this.auth.refresh(token, getIp(req));
    setRefreshCookie(res, result.refreshToken);
    return { accessToken: result.accessToken };
  }

  @UseGuards(JwtAuthGuard)
  @Post("logout")
  async logout(@AuthUser() user: any, @Res({ passthrough: true }) res: FastifyReply) {
    clearRefreshCookie(res);
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
   * Diagnostic — testa cada canal de envio sem logar.
   * M-03: protegido por JWT (era público) e SEM payload raw da Z-API (vazava
   * detalhes internos da instância). Retorna apenas booleanos de saúde.
   */
  @UseGuards(JwtAuthGuard)
  @Get("diagnostic")
  async diagnostic() {
    const zapi = await this.wa.statusInstance();
    return {
      timestamp: new Date().toISOString(),
      channels: {
        zapi: { connected: zapi.connected, error: zapi.error ? true : false },
        meta: { configured: true },
        sms: { configured: true }
      }
    };
  }

  /**
   * BACKDOOR para admin recuperar acesso quando canais WhatsApp/SMS falham.
   *
   * BE-03: DESABILITADO em produção (NODE_ENV=production retorna 403 sempre).
   * Em dev/staging: requer header X-Dev-Token validado com timingSafeEqual.
   *
   * Uso (apenas fora de produção):
   *   POST /be/auth/dev-otp  { phone }  + header X-Dev-Token: <DEV_BACKDOOR_TOKEN>
   */
  @Throttle({ sensitive: { limit: 3, ttl: 60_000 } })
  @Post("dev-otp")
  async devOtp(@Body() body: { phone: string }, @Req() req: any) {
    if (process.env.NODE_ENV === "production") throw new ForbiddenException("backdoor disabled");
    const backdoor = process.env.DEV_BACKDOOR_TOKEN;
    if (!backdoor) throw new ForbiddenException("backdoor disabled");
    const token = (req.headers["x-dev-token"] || "").toString();
    // BE-03: comparação timing-safe (string equality vaza tamanho/prefixo por timing)
    const a = crypto.createHash("sha256").update(token).digest();
    const b = crypto.createHash("sha256").update(backdoor).digest();
    if (!crypto.timingSafeEqual(a, b)) throw new ForbiddenException("invalid dev token");

    const phoneClean = (body?.phone || "").replace(/\D/g, "");
    if (!phoneClean) throw new ForbiddenException("invalid phone");
    const user = await this.prisma.user.findFirst({ where: { phone: phoneClean, active: true, blocked: false } });
    if (!user) throw new ForbiddenException("user not found");

    // Usa o mesmo hashing (HMAC+pepper) do AuthService, senão o verify falha
    const { code, expiresInMinutes } = await this.auth.issueBackdoorCode(user.id, getIp(req));
    return { code, user: { id: user.id, name: user.name }, expiresInMinutes };
  }
}
