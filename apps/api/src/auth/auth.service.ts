/**
 * AuthService — fluxo OTP espelhado do MyClinicSoft.
 * Diferenças vs MCS:
 *   - JWT (jose) em vez de session token raw (queremos stateless API)
 *   - Refresh tokens persistidos em Session.refreshHash
 *   - Re-auth OTP exigido em ações sensíveis (reveal vault, redeploy prod)
 */

import { Injectable, Logger, UnauthorizedException, ForbiddenException, BadRequestException, Inject, forwardRef } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { PrismaService } from "../common/prisma.service";
import { RedisService } from "../common/redis.service";
import { WhatsappService } from "./whatsapp.service";
import { AlertsService } from "../alerts/alerts.service";
import { hmacHash, requireAccessSecret } from "../common/crypto.util";

const OTP_TTL_MIN = 5;
// BD-07: sessão/refresh valem 7 dias (access JWT continua 15min) — antes era 24h, divergindo da doc
const REFRESH_TTL_DAYS = 7;
const SESSION_TTL_MS = REFRESH_TTL_DAYS * 24 * 3600_000;

export interface OtpRequestResult {
  success: boolean;
  firstName?: string;
  error?: string;
}

export interface OtpVerifyResult {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string; email: string; role: string; phone: string };
  expiresAt: Date;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger("Auth");
  // M-02: rate-limit unificado no Redis (antes Map em memória — não sobrevivia a restart
  // nem funcionava com múltiplas réplicas). 5 tentativas por IP em 15min.
  private readonly RATE_MAX = 5;
  private readonly RATE_WINDOW_SEC = 15 * 60;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    // forwardRef: AlertsModule importa AuthModule → quebra o ciclo (M-05)
    @Inject(forwardRef(() => AlertsService)) private readonly alerts: AlertsService
  ) {}

  // ─── helpers ────────────────────────────────────────────
  private generateCode(): string {
    return (100_000 + crypto.randomInt(900_000)).toString();
  }
  /** BE-09: sem fallback hardcoded — env é validada no boot (main.ts). */
  private accessSecret(): string {
    return requireAccessSecret();
  }
  /** BD-08: HMAC com pepper server-side (impede ataque offline a OTP de 6 dígitos / rainbow table de refresh). */
  private hashValue(v: string): string {
    return hmacHash(v);
  }
  private formatPhone(p: string): string {
    return p.replace(/\D/g, "");
  }
  private async checkRateLimit(ip: string): Promise<{ allowed: boolean; retryAfterSec?: number }> {
    const key = `auth:ratelimit:${ip}`;
    try {
      const count = await this.redis.client.incr(key);
      if (count === 1) await this.redis.client.expire(key, this.RATE_WINDOW_SEC);
      if (count > this.RATE_MAX) {
        const ttl = await this.redis.client.ttl(key);
        return { allowed: false, retryAfterSec: ttl > 0 ? ttl : this.RATE_WINDOW_SEC };
      }
      return { allowed: true };
    } catch {
      // Redis fora: fail-open p/ não bloquear login legítimo, mas registra.
      this.log.warn("rate-limit Redis indisponível; liberando (fail-open)");
      return { allowed: true };
    }
  }

  // ─── 1. REQUEST CODE ────────────────────────────────────
  async requestCode(
    phone: string,
    ip: string,
    channel: "whatsapp" | "sms" | "auto" = "auto"
  ): Promise<OtpRequestResult & { channel?: string }> {
    const rate = await this.checkRateLimit(ip);
    if (!rate.allowed) {
      throw new ForbiddenException({
        error: "Muitas tentativas",
        message: `Tente novamente em ${Math.ceil(rate.retryAfterSec! / 60)} min.`,
        retryAfterSec: rate.retryAfterSec
      });
    }

    const phoneClean = this.formatPhone(phone);
    const user = await this.prisma.user.findFirst({
      where: { phone: phoneClean, active: true, blocked: false }
    });
    if (!user) {
      // Mensagem genérica anti-enumeração
      return { success: true, firstName: "Usuário" };
    }

    const code = this.generateCode();
    const codeHash = this.hashValue(code);
    const expiresAt = new Date(Date.now() + OTP_TTL_MIN * 60_000);

    // Invalida tokens não-usados antigos
    await this.prisma.otpToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true }
    });
    await this.prisma.otpToken.create({
      data: {
        userId: user.id,
        codeHash,
        channel: channel === "sms" ? "sms" : "whatsapp",
        purpose: "login",
        expiresAt,
        ipAddress: ip
      }
    });

    const result = await this.wa.sendOtp(user.phone, code, channel);
    if (!result.sent) {
      this.log.error(`OTP envio falhou para ${user.phone}: ${result.error}`);
      // Não revelamos a falha pro cliente (anti-enumeração)
    }
    return {
      success: true,
      firstName: user.name.split(" ")[0],
      channel: result.provider || channel
    };
  }

  // ─── 2. VERIFY CODE ─────────────────────────────────────
  async verifyCode(phone: string, code: string, ip: string, userAgent: string): Promise<OtpVerifyResult> {
    const phoneClean = this.formatPhone(phone);
    const codeHash = this.hashValue(code);

    const user = await this.prisma.user.findFirst({ where: { phone: phoneClean, active: true } });
    if (!user) throw new UnauthorizedException("Código inválido ou expirado");

    // BE-02: consumo atômico (anti-replay/TOCTOU) — marca usado na mesma operação que valida.
    const consumed = await this.prisma.otpToken.updateMany({
      where: { userId: user.id, codeHash, used: false, purpose: "login", expiresAt: { gt: new Date() } },
      data: { used: true }
    });
    if (consumed.count === 0) throw new UnauthorizedException("Código inválido ou expirado");

    // Concurrent login detection (espelho MCS)
    const existingActive = await this.prisma.session.findFirst({
      where: { userId: user.id, status: "active" }
    });
    if (existingActive && existingActive.ipAddress !== ip && existingActive.ipAddress !== "unknown") {
      this.log.warn(`Login simultâneo: user=${user.name} oldIp=${existingActive.ipAddress} newIp=${ip}`);
      // M-05: alerta admin de login concorrente (sessão anterior será revogada abaixo).
      this.alerts.dispatch({
        ruleKey: `concurrent_login_${user.id}`,
        severity: "warning",
        title: "Login concorrente detectado",
        message: `${user.name}: nova sessão de ${ip} (anterior: ${existingActive.ipAddress}). Sessão antiga revogada.`
      }).catch(() => { /* alerta best-effort, não bloqueia login */ });
    }

    // Revoga sessões anteriores (single-session policy)
    await this.prisma.session.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "revoked_by_new_login" }
    });

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, name: user.name, role: user.role },
      { secret: this.accessSecret(), expiresIn: "15m" }
    );
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const refreshHash = this.hashValue(refreshToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

    // BE-05: session + lastLogin + audit numa transação (evita estado parcial em falha)
    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: this.hashValue(accessToken),
          refreshHash,
          ipAddress: ip,
          userAgent: userAgent || "unknown",
          status: "active",
          expiresAt
        }
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } }),
      this.prisma.auditLog.create({
        data: { userId: user.id, action: "LOGIN", entityType: "USER", entityId: user.id, ipAddress: ip }
      })
    ]);
    return {
      accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, phone: user.phone },
      expiresAt
    };
  }

  // ─── 3. RE-AUTH OTP (ações sensíveis) ───────────────────
  async issueReauthCode(userId: string, ip: string): Promise<{ success: true }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();
    const code = this.generateCode();
    await this.prisma.otpToken.create({
      data: {
        userId: user.id,
        codeHash: this.hashValue(code),
        channel: "whatsapp",
        purpose: "reveal",
        expiresAt: new Date(Date.now() + 5 * 60_000), // 5min para reveal
        ipAddress: ip
      }
    });
    await this.wa.sendOtp(user.phone, code);
    return { success: true };
  }

  async verifyReauthCode(userId: string, code: string): Promise<boolean> {
    // BE-02: consumo atômico — duas requisições paralelas com o mesmo código não passam ambas.
    const consumed = await this.prisma.otpToken.updateMany({
      where: {
        userId,
        codeHash: this.hashValue(code),
        used: false,
        purpose: "reveal",
        expiresAt: { gt: new Date() }
      },
      data: { used: true }
    });
    return consumed.count > 0;
  }

  /** BE-03: emissão de código backdoor (somente dev/staging — bloqueado em prod no controller). */
  async issueBackdoorCode(userId: string, ip: string): Promise<{ code: string; expiresInMinutes: number }> {
    const ttlMin = 10;
    const code = this.generateCode();
    await this.prisma.$transaction([
      this.prisma.otpToken.updateMany({ where: { userId, used: false }, data: { used: true } }),
      this.prisma.otpToken.create({
        data: {
          userId,
          codeHash: this.hashValue(code),
          channel: "backdoor",
          purpose: "login",
          expiresAt: new Date(Date.now() + ttlMin * 60_000),
          ipAddress: ip
        }
      })
    ]);
    return { code, expiresInMinutes: ttlMin };
  }

  // ─── 4. REFRESH ─────────────────────────────────────────
  /** FE-02/FE-03: rotação de refresh token a cada uso — token vazado vira inválido no próximo refresh legítimo. */
  async refresh(refreshToken: string, ip: string): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshHash = this.hashValue(refreshToken);
    const session = await this.prisma.session.findFirst({
      where: { refreshHash, status: "active", expiresAt: { gt: new Date() } },
      include: { user: true }
    });
    if (!session) throw new UnauthorizedException("Refresh inválido");
    const accessToken = await this.jwt.signAsync(
      { sub: session.user.id, name: session.user.name, role: session.user.role },
      { secret: this.accessSecret(), expiresIn: "15m" }
    );
    const newRefreshToken = crypto.randomBytes(32).toString("hex");
    // Rotação atômica: só atualiza se o hash antigo ainda for o corrente (anti-replay concorrente)
    const rotated = await this.prisma.session.updateMany({
      where: { id: session.id, refreshHash, status: "active" },
      data: {
        tokenHash: this.hashValue(accessToken),
        refreshHash: this.hashValue(newRefreshToken),
        lastActivity: new Date(),
        ipAddress: ip
      }
    });
    if (rotated.count === 0) throw new UnauthorizedException("Refresh inválido");
    return { accessToken, refreshToken: newRefreshToken };
  }

  // ─── 5. LOGOUT ──────────────────────────────────────────
  async logout(userId: string) {
    await this.prisma.session.updateMany({
      where: { userId, status: "active" },
      data: { status: "logged_out" }
    });
    return { success: true };
  }
}
