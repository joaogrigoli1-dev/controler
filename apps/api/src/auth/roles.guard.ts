import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ROLES_KEY } from "./roles.decorator";

/**
 * RolesGuard (A-01) — nega acesso se o papel do usuário não estiver na lista de @Roles.
 * Depende de req.user preenchido pelo JwtAuthGuard; sem @Roles na rota, libera.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ]);
    if (!required || required.length === 0) return true;
    const req = ctx.switchToHttp().getRequest();
    const role = req.user?.role;
    if (!role) throw new ForbiddenException("Sessão ausente");
    if (!required.includes(role)) {
      throw new ForbiddenException(`Acesso restrito: requer papel ${required.join(" ou ")}`);
    }
    return true;
  }
}
