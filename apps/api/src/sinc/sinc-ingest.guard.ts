import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, timingSafeEqual } from "node:crypto";

@Injectable()
export class SincIngestGuard implements CanActivate {
  constructor(@Inject(ConfigService) private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>("SINC_INGEST_TOKEN");
    const supplied = context.switchToHttp().getRequest().headers["x-sinc-ingest-token"];
    // Dedicated key, provisioned through SSM; never reuse a user JWT or backdoor.
    const otherKeys = ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "DEV_BACKDOOR_TOKEN"].map(key => this.config.get<string>(key)).filter(Boolean);
    if (typeof expected !== "string" || expected.length < 32 || expected.length > 512 || otherKeys.includes(expected) || typeof supplied !== "string" || supplied.length > 512) throw new UnauthorizedException("Ingestão não autorizada");
    const digest = (value: string) => createHash("sha256").update(value).digest();
    if (!timingSafeEqual(digest(expected), digest(supplied))) throw new UnauthorizedException("Ingestão não autorizada");
    return true;
  }
}
