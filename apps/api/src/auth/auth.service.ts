/**
 * AuthService — fluxo OTP espelhado do MyClinicSoft.
 * Diferenças vs MCS:
 *   - JWT (jose) em vez de session token raw (queremos stateless API)
 *   - Refresh tokens persistidos em Session.refreshHash
 *   - Re-auth OTP exigido em ações sensíveis (reveal vault, redeploy prod)
 */

import { Injectable, Logger, UnauthorizedException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { PrismaService } from "../common/prisma.service";
import { WhatsappService } from "./whatsapp.service";

const OTP_TTL_MIN = 10;
const SESSION_TTL_HOURS = 24;
const REFRESH_TTL_DAYS = 7;

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
  // Rate-limit: 5 tentativas por IP em 15min (espelho MCS)
  private rateLimitMap = new Map<string, { count: number; firstAt: number }>();
  private readonly RATE_MAX = 5;
  private readonly RATE_WINDOW_MS = 15 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly wa: WhatsappService,
    private readonly jwt: JwtService
  ) {}

  // ─── helpers ────────────────────────────────────────────
  private generateCode(): string {
    return (100_000 + crypto.randomInt(900_000)).toString();
  }
  private hashValue(v: string): string {
    return crypto.createHash("sha256").update(v).digest("hex");
  }
  private formatPhone(p: string): string {
    return p.replace(/\D/g, "");
  }
  private checkRateLimit(ip: string): { allowed: boolean; retryAfterSec?: number } {
    const now = Date.now();
    const r = this.rateLimitMap.get(ip);
    if (!r) {
      this.rateLimitMap.set(ip, { count: 1, firstAt: now });
      return { allowed: true };
    }
    if (now - r.firstAt > this.RATE_WINDOW_MS) {
      this.rateLimitMap.set(ip, { count: 1, firstAt: now });
      return { allowed: true };
    }
    if (r.count >= this.RATE_MAX) {
      const retryAfterSec = Math.ceil((r.firstAt + this.RATE_WINDOW_MS - now) / 1000);
      return { allowed: false, retryAfterSec };
    }
    r.count++;
    return { allowed: true };
  }

  // ─── 1. REQUEST CODE ────────────────────────────────────
  async requestCode(
    phone: string,
    ip: string,
    channel: "whatsapp" | "sms" | "auto" = "auto"
  ): Promise<OtpRequestResult & { channel?: string }> {
    const rate = this.checkRateLimit(ip);
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

    const token = await this.prisma.otpToken.findFirst({
      where: { userId: user.id, codeHash, used: false, purpose: "login", expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" }
    });
    if (!token) throw new UnauthorizedException("Código inválido ou expirado");

    // Concurrent login detection (espelho MCS)
    const existingActive = await this.prisma.session.findFirst({
      where: { userId: user.id, status: "active" }
    });
    if (existingActive && existingActive.ipAddress !== ip && existingActive.ipAddress !== "unknown") {
      this.log.warn(`Login simultâneo: user=${user.name} oldIp=${existingActive.ipAddress} newIp=${ip}`);
      // TODO: disparar alerta admin via AlertsService (injetar via forward ref)
    }

    // Revoga sessões anteriores (single-session policy)
    await this.prisma.session.updateMany({
      where: { userId: user.id, status: "active" },
      data: { status: "revoked_by_new_login" }
    });

    const accessToken = await this.jwt.signAsync(
      { sub: user.id, name: user.name, role: user.role },
      { secret: process.env.JWT_ACCESS_SECRET || "dev-secret-change-me-min-32-chars-please", expiresIn: "15m" }
    );
    const refreshToken = crypto.randomBytes(32).toString("hex");
    const refreshHash = this.hashValue(refreshToken);
    const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);

    await this.prisma.session.create({
      data: {
        userId: user.id,
        tokenHash: this.hashValue(accessToken),
        refreshHash,
        ipAddress: ip,
        userAgent: userAgent || "unknown",
        status: "active",
        expiresAt
      }
    });

    // Marca OTP usado (anti-replay)
    await this.prisma.otpToken.update({ where: { id: token.id }, data: { used: true } });

    await this.prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    await this.prisma.auditLog.create({
      data: { userId: user.id, action: "LOGIN", entityType: "USER", entityId: user.id, ipAddress: ip }
    });
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
    const token = await this.prisma.otpToken.findFirst({
      where: {
        userId,
        codeHash: this.hashValue(code),
        used: false,
        purpose: "reveal",
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: "desc" }
    });
    if (!token) return false;
    await this.prisma.otpToken.update({ where: { id: token.id }, data: { used: true } });
    return true;
  }

  // ─── 4. REFRESH ─────────────────────────────────────────
  async refresh(refreshToken: string, ip: string): Promise<{ accessToken: string }> {
    const refreshHash = this.hashValue(refreshToken);
    const session = await this.prisma.session.findFirst({
      where: { refreshHash, status: "active", expiresAt: { gt: new Date() } },
      include: { user: true }
    });
    if (!session) throw new UnauthorizedException("Refresh inválido");
    const accessToken = await this.jwt.signAsync(
      { sub: session.user.id, name: session.user.name, role: session.user.role },
      { secret: process.env.JWT_ACCESS_SECRET || "dev-secret-change-me-min-32-chars-please", expiresIn: "15m" }
    );
    await this.prisma.session.update({
      where: { id: session.id },
      data: { tokenHash: this.hashValue(accessToken), lastActivity: new Date(), ipAddress: ip }
    });
    return { accessToken };
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
