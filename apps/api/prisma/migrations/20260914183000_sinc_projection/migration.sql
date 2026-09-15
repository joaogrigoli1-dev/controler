-- Additive projection store. No credentials, local SQLite or user conversations.
CREATE TABLE "sinc_projection_events" (
  "eventId" VARCHAR(128) PRIMARY KEY,
  "idempotencyKey" VARCHAR(128) NOT NULL UNIQUE,
  "projectId" VARCHAR(128) NOT NULL,
  "entityId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" BETWEEN 1 AND 1000000),
  "contentHash" VARCHAR(71) NOT NULL CHECK ("contentHash" ~ '^sha256:[a-f0-9]{64}$'),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "envelope" JSONB NOT NULL,
  CONSTRAINT "sinc_projection_events_projectId_entityId_revision_key" UNIQUE ("projectId", "entityId", "revision")
);
CREATE INDEX "sinc_projection_events_projectId_occurredAt_idx" ON "sinc_projection_events" ("projectId", "occurredAt" DESC);
CREATE INDEX "sinc_projection_events_receivedAt_idx" ON "sinc_projection_events" ("receivedAt" DESC);
CREATE TABLE "sinc_projection_heads" (
  "projectId" VARCHAR(128) NOT NULL,
  "entityId" VARCHAR(128) NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" BETWEEN 1 AND 1000000),
  "eventId" VARCHAR(128) NOT NULL UNIQUE REFERENCES "sinc_projection_events" ("eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
  PRIMARY KEY ("projectId", "entityId")
);
CREATE TABLE "sinc_projection_batches" (
  "batchId" VARCHAR(36) PRIMARY KEY,
  "idempotencyKey" VARCHAR(71) NOT NULL UNIQUE,
  "projectId" VARCHAR(128) NOT NULL,
  "contentHash" VARCHAR(71) NOT NULL CHECK ("contentHash" ~ '^sha256:[a-f0-9]{64}$'),
  "generatedAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "eventCount" INTEGER NOT NULL CHECK ("eventCount" BETWEEN 1 AND 100)
);
CREATE INDEX "sinc_projection_batches_projectId_receivedAt_idx" ON "sinc_projection_batches" ("projectId", "receivedAt" DESC);
