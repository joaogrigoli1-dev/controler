import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, createParamDecorator } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../common/prisma.service";
import * as crypto from "crypto";

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService, private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth: string = req.headers.authorization || "";
    if (!auth.startsWith("Bearer ")) throw new UnauthorizedException("Token ausente");
    const token = auth.slice(7);
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET || "dev-secret-change-me-min-32-chars-please"
      });
    } catch {
      throw new UnauthorizedException("Token inválido");
    }
    // Verifica que a sessão ainda está ativa
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const session = await this.prisma.session.findUnique({ where: { tokenHash } });
    if (!session || session.status !== "active" || session.expiresAt < new Date()) {
      throw new UnauthorizedException("Sessão revogada ou expirada");
    }
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastActivity: new Date() }
    });
    req.user = { id: payload.sub, name: payload.name, role: payload.role, sessionId: session.id };
    return true;
  }
}

export const AuthUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user;
});
