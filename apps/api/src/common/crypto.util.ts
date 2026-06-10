/**
 * Helpers de crypto compartilhados (BE-09 / BD-08).
 * - requireAccessSecret(): JWT secret sem fallback hardcoded (validada no boot em main.ts).
 * - hmacHash(): HMAC-SHA256 com pepper server-side para tokenHash/refreshHash/codeHash.
 *   Pepper vem de TOKEN_PEPPER (SSM); fallback é a própria JWT secret (nunca string fixa).
 */
import * as crypto from "crypto";

export function requireAccessSecret(): string {
  const s = process.env.JWT_ACCESS_SECRET;
  if (!s || s.length < 32) {
    throw new Error("JWT_ACCESS_SECRET ausente ou curta (mín. 32 chars)");
  }
  return s;
}

export function hmacHash(value: string): string {
  const pepper = process.env.TOKEN_PEPPER || requireAccessSecret();
  return crypto.createHmac("sha256", pepper).update(value).digest("hex");
}
