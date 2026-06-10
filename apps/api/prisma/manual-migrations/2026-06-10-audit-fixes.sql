-- Auditoria 2026-06-10 — BD-03, BD-05, BD-06, BD-09, BD-13
-- Migração SEGURA (preserva dados — usa cast USING em vez de DROP/ADD COLUMN).
--
-- ⚠ APLICAR ANTES de rodar `prisma db push` (o db push faria DROP COLUMN e perderia dados).
-- Aplicar com:
--   cd apps/api && npx prisma db execute --file prisma/manual-migrations/2026-06-10-audit-fixes.sql
-- Depois:
--   npx prisma generate
-- Validar: npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma
-- (deve retornar vazio)

BEGIN;

-- BD-06: enums nativos
CREATE TYPE "UserRole" AS ENUM ('admin', 'viewer');
CREATE TYPE "OtpPurpose" AS ENUM ('login', 'reveal', 'sensitive_action');
CREATE TYPE "SessionStatus" AS ENUM ('active', 'revoked_by_new_login', 'expired', 'logged_out', 'blocked');

-- users.role: String -> UserRole (preserva valores; falha explícita se houver valor fora do enum)
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE "UserRole" USING ("role"::"UserRole");
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'admin';

-- otp_tokens.purpose: String -> OtpPurpose
ALTER TABLE "otp_tokens" ALTER COLUMN "purpose" DROP DEFAULT;
ALTER TABLE "otp_tokens" ALTER COLUMN "purpose" TYPE "OtpPurpose" USING ("purpose"::"OtpPurpose");
ALTER TABLE "otp_tokens" ALTER COLUMN "purpose" SET DEFAULT 'login';

-- sessions.status: String -> SessionStatus
ALTER TABLE "sessions" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "sessions" ALTER COLUMN "status" TYPE "SessionStatus" USING ("status"::"SessionStatus");
ALTER TABLE "sessions" ALTER COLUMN "status" SET DEFAULT 'active';

-- BD-13: updatedAt
ALTER TABLE "otp_tokens" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "sessions"   ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- BD-03: vault_audit_logs.userId nullable + ON DELETE SET NULL (preserva trilha de auditoria)
ALTER TABLE "vault_audit_logs" DROP CONSTRAINT "vault_audit_logs_userId_fkey";
ALTER TABLE "vault_audit_logs" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "vault_audit_logs" ADD CONSTRAINT "vault_audit_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BD-09: índice que cobre a query de verificação de OTP
DROP INDEX IF EXISTS "otp_tokens_userId_used_expiresAt_idx";
CREATE INDEX "otp_tokens_userId_purpose_used_expiresAt_idx"
  ON "otp_tokens"("userId", "purpose", "used", "expiresAt");

-- BD-05: índice para análise de alertas por regra
CREATE INDEX "alert_logs_ruleId_createdAt_idx" ON "alert_logs"("ruleId", "createdAt" DESC);

-- BD-08: hashes antigos eram SHA-256 puro; agora são HMAC+pepper → invalida tokens/sessões
-- pendentes (usuários precisam relogar — esperado e desejável).
UPDATE "sessions" SET "status" = 'expired' WHERE "status" = 'active';
UPDATE "otp_tokens" SET "used" = true WHERE "used" = false;

COMMIT;
