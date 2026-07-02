import { SetMetadata } from "@nestjs/common";

/**
 * @Roles('admin') — marca rotas que exigem papel específico.
 * Avaliado pelo RolesGuard (que deve rodar DEPOIS do JwtAuthGuard, pois usa req.user.role).
 * A-01: aplicado nas rotas destrutivas (vault reveal, srv1/coolify actions, scanner fix).
 */
export const ROLES_KEY = "roles";
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
