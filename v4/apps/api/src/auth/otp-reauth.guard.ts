/**
 * OtpReauthGuard — exige header `X-Otp-Code` com OTP fresh (purpose=reveal).
 * Usado em rotas sensíveis: vault reveal, redeploy prod, stop container, etc.
 */

import { CanActivate, ExecutionContext, Injectable, ForbiddenException } from "@nestjs/common";
import { AuthService } from "./auth.service";

@Injectable()
export class OtpReauthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    const otp = req.headers["x-otp-code"];
    if (!user) throw new ForbiddenException("Sessão ausente");
    if (!otp || typeof otp !== "string" || otp.length !== 6) {
      throw new ForbiddenException("Re-auth OTP exigido — solicite /auth/reauth/request e envie X-Otp-Code");
    }
    const ok = await this.auth.verifyReauthCode(user.id, otp);
    if (!ok) throw new ForbiddenException("OTP inválido");
    return true;
  }
}
