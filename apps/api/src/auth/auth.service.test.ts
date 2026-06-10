/**
 * Unit tests para AuthService — funções puras (hash, code gen, rate limit).
 * Sem mock de Prisma — focado em lógica de criptografia e validação.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as crypto from "crypto";
import { hmacHash } from "../common/crypto.util";

// BD-08: hashing real agora é HMAC-SHA256 com pepper (crypto.util.ts)
process.env.TOKEN_PEPPER = process.env.TOKEN_PEPPER || "test-pepper-for-unit-tests-only-32chars";

// Helpers replicados (mesma lógica do AuthService)
function generateCode(): string {
  return (100_000 + crypto.randomInt(900_000)).toString();
}
const hashValue = hmacHash;
function formatPhone(p: string): string {
  return p.replace(/\D/g, "");
}

describe("AuthService helpers", () => {
  describe("generateCode", () => {
    it("retorna sempre 6 dígitos", () => {
      for (let i = 0; i < 50; i++) {
        const code = generateCode();
        expect(code).toMatch(/^\d{6}$/);
        expect(parseInt(code, 10)).toBeGreaterThanOrEqual(100_000);
        expect(parseInt(code, 10)).toBeLessThanOrEqual(999_999);
      }
    });

    it("códigos diferentes em chamadas seguidas (sanity)", () => {
      const codes = new Set<string>();
      for (let i = 0; i < 100; i++) codes.add(generateCode());
      // Em 100 amostras de 900k espaço, devemos ter ≥98 únicos
      expect(codes.size).toBeGreaterThan(95);
    });
  });

  describe("hashValue (hmac-sha256 + pepper)", () => {
    it("hex de 64 caracteres", () => {
      const h = hashValue("123456");
      expect(h.length).toBe(64);
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });
    it("NÃO é sha256 puro (BD-08: pepper impede rainbow table)", () => {
      const plainSha = crypto.createHash("sha256").update("123456").digest("hex");
      expect(hashValue("123456")).not.toBe(plainSha);
    });
    it("determinístico", () => {
      expect(hashValue("abc")).toBe(hashValue("abc"));
    });
    it("colisão diferente", () => {
      expect(hashValue("abc")).not.toBe(hashValue("abd"));
    });
    it("muda com pepper diferente", () => {
      const before = hashValue("abc");
      const oldPepper = process.env.TOKEN_PEPPER;
      process.env.TOKEN_PEPPER = "another-pepper-value-with-32-chars!!";
      expect(hashValue("abc")).not.toBe(before);
      process.env.TOKEN_PEPPER = oldPepper;
    });
  });

  describe("formatPhone", () => {
    it("remove caracteres não numéricos", () => {
      expect(formatPhone("+55 (65) 98466-5555")).toBe("5565984665555");
      expect(formatPhone("65 9 8466-5555")).toBe("65984665555");
    });
    it("idempotente", () => {
      expect(formatPhone(formatPhone("(65) 9.8466-5555"))).toBe("65984665555");
    });
  });
});
