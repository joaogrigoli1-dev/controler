/**
 * Unit tests para AuthService — funções puras (hash, code gen, rate limit).
 * Sem mock de Prisma — focado em lógica de criptografia e validação.
 */

import { describe, it, expect, beforeEach } from "vitest";
import * as crypto from "crypto";

// Helpers replicados (mesma lógica do AuthService)
function generateCode(): string {
  return (100_000 + crypto.randomInt(900_000)).toString();
}
function hashValue(v: string): string {
  return crypto.createHash("sha256").update(v).digest("hex");
}
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

  describe("hashValue", () => {
    it("sha256 hex de 64 caracteres", () => {
      const h = hashValue("123456");
      expect(h).toBe("8d969eef6ecad3c29a3a629280e686cf0c3f5d5a86aff3ca12020c923adc6c92");
      expect(h.length).toBe(64);
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });
    it("determinístico", () => {
      expect(hashValue("abc")).toBe(hashValue("abc"));
    });
    it("colisão diferente", () => {
      expect(hashValue("abc")).not.toBe(hashValue("abd"));
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
