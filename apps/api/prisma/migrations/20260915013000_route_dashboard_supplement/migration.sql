-- F6 additive store. Supplements contain only typed identifiers/nullable metrics and
-- must reference an already persisted F5 projection event.
CREATE TABLE "route_dashboard_supplements" (
  "supplementId" VARCHAR(36) PRIMARY KEY,
  "idempotencyKey" VARCHAR(71) NOT NULL UNIQUE,
  "projectId" VARCHAR(128) NOT NULL CHECK ("projectId" = 'roteador'),
  "entityId" VARCHAR(36) NOT NULL,
  "revision" INTEGER NOT NULL CHECK ("revision" BETWEEN 1 AND 1000000),
  "decisionHash" VARCHAR(71) NOT NULL CHECK ("decisionHash" ~ '^sha256:[a-f0-9]{64}$'),
  "eventId" VARCHAR(128) NOT NULL REFERENCES "sinc_projection_events" ("eventId") ON DELETE RESTRICT ON UPDATE CASCADE,
  "contentHash" VARCHAR(71) NOT NULL CHECK ("contentHash" ~ '^sha256:[a-f0-9]{64}$'),
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "envelope" JSONB NOT NULL,
  CONSTRAINT "route_dashboard_supplements_projectId_entityId_revision_key" UNIQUE ("projectId", "entityId", "revision")
);
CREATE INDEX "route_dashboard_supplements_projectId_occurredAt_idx" ON "route_dashboard_supplements" ("projectId", "occurredAt" DESC);
CREATE INDEX "route_dashboard_supplements_eventId_idx" ON "route_dashboard_supplements" ("eventId");

CREATE TABLE "route_dashboard_supplement_batches" (
  "batchId" VARCHAR(36) PRIMARY KEY,
  "idempotencyKey" VARCHAR(71) NOT NULL UNIQUE,
  "projectId" VARCHAR(128) NOT NULL CHECK ("projectId" = 'roteador'),
  "contentHash" VARCHAR(71) NOT NULL CHECK ("contentHash" ~ '^sha256:[a-f0-9]{64}$'),
  "generatedAt" TIMESTAMPTZ(3) NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "itemCount" INTEGER NOT NULL CHECK ("itemCount" BETWEEN 1 AND 100)
);
CREATE INDEX "route_dashboard_supplement_batches_projectId_receivedAt_idx" ON "route_dashboard_supplement_batches" ("projectId", "receivedAt" DESC);
