import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { assertSafeEnvelope, canonicalHash, parseSincBatch, projectQuerySchema, SincEvent, SincProjectionEventSchema } from "./sinc.schema";

export const SINC_DASHBOARD_SAMPLE_LIMIT = 1000;
// Evidence supplied by the session coordinator; a dated photograph, never live probing.
export const SINC_INTEGRATION_SNAPSHOT = {
  evidenceKind: "last_measured", measuredAt: "2026-09-14T20:18:00-04:00",
  clients: [
    { client: "Codex", status: "workflow_validated", mcpConfig: "present" },
    { client: "Claude Code", status: "workflow_validated", mcpConfig: "present" },
    { client: "Cowork", status: "connector_configured", mcpConfig: "present" },
  ],
  versions: [
    { resource: "sinc-mcp", version: "2.1.0", status: "declared", clients: ["Codex", "Claude Code", "Cowork"] },
    { resource: "mac-dark", version: "2.6.3", status: "parity_matched", clients: ["Codex", "Claude", "dsh"] },
    { resource: "mac-light", version: "1.1.0", status: "parity_matched", clients: ["Codex", "Claude", "dsh"] },
  ],
  projects: ["myclinicsoft", "t4net-so", "senhas-fisiomt", "roteador"].map(projectId => ({ projectId, policy: "configured", map: "linked", obsidian: "linked" })),
  contract: { contractId: "5feee1ff-bfc1-4f42-9709-b08a786d9779", requirementCount: 5, status: "prepared" },
} as const;

/** All aggregation is over the explicitly bounded recent sample, never guessed totals. */
export function buildSincDashboard(rows: Array<{ envelope: unknown; contentHash: string; receivedAt: Date }>, totalStoredEvents: number, projects: string[], projectId: string | null) {
  const events = rows.map(row => {
    assertSafeEnvelope(row.envelope);
    const event = SincProjectionEventSchema.parse(row.envelope);
    if (canonicalHash(event) !== row.contentHash) throw new Error("Projeção indisponível");
    return event;
  });
  const costs = (key: "api_equivalent_cost_micros" | "observed_billed_cost_micros") => {
    const known = events.map(e => e.metrics[key]).filter((value): value is number => value !== null);
    const sum = known.reduce((total, value) => total + BigInt(value), 0n).toString();
    return { currency: "USD" as const, knownCount: known.length, unknownCount: events.length - known.length, knownSumMicros: sum, totalMicros: events.length > 0 && known.length === events.length ? sum : null };
  };
  const durations = events.map(e => e.metrics.duration_ms).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const percentile = (p: number) => durations.length ? durations[Math.ceil(durations.length * p) - 1] : null;
  const models = new Map<string, { modelId: string; effort: string; state: SincEvent["state"]; count: number }>();
  for (const event of events) {
    if (!event.route) continue;
    const key = JSON.stringify([event.route.model_id, event.route.effort, event.state]);
    const group = models.get(key) ?? { modelId: event.route.model_id, effort: event.route.effort, state: event.state, count: 0 };
    group.count++;
    models.set(key, group);
  }
  const latestOccurredAt = events.length ? events.map(e => e.occurred_at).sort((a, b) => Date.parse(b) - Date.parse(a))[0] : null;
  const latestReceivedAt = rows.length ? new Date(Math.max(...rows.map(r => r.receivedAt.getTime()))).toISOString() : null;
  return {
    integration: structuredClone(SINC_INTEGRATION_SNAPSHOT),
    generatedAt: new Date().toISOString(), source: "postgres_projection" as const, authority: "informational_only" as const,
    state: events.length ? "available" as const : "empty" as const, projectId, projects,
    overview: {
      totalEvents: events.length, recommendations: events.filter(e => e.state === "recommendation").length,
      blocked: events.filter(e => e.state === "blocked").length, integrationFailures: events.filter(e => e.state === "integration_failure").length,
      observedEvents: events.filter(e => e.source.data_class === "observed").length, simulatedEvents: events.filter(e => e.source.data_class === "simulated").length,
      apiEquivalentCost: costs("api_equivalent_cost_micros"), observedBilledCost: costs("observed_billed_cost_micros"),
      durationMs: { p50: percentile(.5), p95: percentile(.95) },
    },
    recentRoutes: events.slice(0, 50), modelTree: [...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId) || a.effort.localeCompare(b.effort) || a.state.localeCompare(b.state)),
    health: { sampleLimit: SINC_DASHBOARD_SAMPLE_LIMIT, sampleLimited: totalStoredEvents > rows.length, totalStoredEvents, latestOccurredAt, latestReceivedAt, lagSeconds: latestOccurredAt ? Math.max(0, Math.floor((Date.now() - Date.parse(latestOccurredAt)) / 1000)) : null, gapStatus: "not_measured" as const },
  };
}

@Injectable()
export class SincService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(input: unknown) {
    let batch: ReturnType<typeof parseSincBatch>;
    try { batch = parseSincBatch(input); } catch { throw new BadRequestException("Envelope Sinc inválido"); }
    try {
      return await this.prisma.$transaction(async tx => {
        // Serialize only this projection's writers across API replicas. Readers remain free.
        await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(1936289379)`;
        const prior = await tx.sincProjectionBatch.findMany({ where: { OR: [{ batchId: batch.batch_id }, { idempotencyKey: batch.idempotency_key }] } });
        if (prior.length) {
          if (prior.length !== 1 || prior[0].batchId !== batch.batch_id || prior[0].idempotencyKey !== batch.idempotency_key || prior[0].contentHash !== batch.batch_hash) throw new ConflictException("Conflito de idempotência Sinc");
          return { status: "accepted" as const, inserted: 0, replayed: prior[0].eventCount, batchReplayed: true, batchHash: batch.batch_hash, authority: "informational_only" as const };
        }
        let inserted = 0, replayed = 0;
        for (const event of batch.events) {
          const contentHash = canonicalHash(event);
          const matches = await tx.sincProjectionEvent.findMany({ where: { OR: [
            { eventId: event.event_id }, { idempotencyKey: event.idempotency_key },
            { projectId: event.project_id, entityId: event.entity_id, revision: event.revision },
          ] } });
          if (matches.length) {
            if (matches.length !== 1 || matches[0].eventId !== event.event_id || matches[0].idempotencyKey !== event.idempotency_key || matches[0].contentHash !== contentHash) throw new ConflictException("Conflito de idempotência Sinc");
            replayed++;
            continue;
          }
          await tx.sincProjectionEvent.create({ data: {
            eventId: event.event_id, idempotencyKey: event.idempotency_key, projectId: event.project_id,
            entityId: event.entity_id, revision: event.revision, contentHash, occurredAt: new Date(event.occurred_at),
            envelope: event as Prisma.InputJsonValue,
          } });
          await tx.$executeRaw`INSERT INTO sinc_projection_heads ("projectId", "entityId", "revision", "eventId")
            VALUES (${event.project_id}, ${event.entity_id}, ${event.revision}, ${event.event_id})
            ON CONFLICT ("projectId", "entityId") DO UPDATE SET "revision" = EXCLUDED."revision", "eventId" = EXCLUDED."eventId"
            WHERE sinc_projection_heads."revision" < EXCLUDED."revision"`;
          inserted++;
        }
        await tx.sincProjectionBatch.create({ data: { batchId: batch.batch_id, idempotencyKey: batch.idempotency_key, projectId: batch.project_id, contentHash: batch.batch_hash, generatedAt: new Date(batch.generated_at), eventCount: batch.events.length } });
        return { status: "accepted" as const, inserted, replayed, batchReplayed: false, batchHash: batch.batch_hash, authority: "informational_only" as const };
      }, { maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException("Projeção Sinc indisponível");
    }
  }

  async dashboard(input: unknown) {
    let projectId: string | undefined;
    try { assertSafeEnvelope(input); projectId = projectQuerySchema.parse(input).projectId; }
    catch { throw new BadRequestException("Consulta Sinc inválida"); }
    try {
      return await this.prisma.$transaction(async tx => {
        const where = projectId ? { projectId } : {};
        const [rows, total, groups] = await Promise.all([
          tx.sincProjectionEvent.findMany({ where, orderBy: [{ occurredAt: "desc" }, { eventId: "asc" }], take: SINC_DASHBOARD_SAMPLE_LIMIT, select: { envelope: true, contentHash: true, receivedAt: true } }),
          tx.sincProjectionEvent.count({ where }),
          tx.sincProjectionEvent.findMany({ distinct: ["projectId"], select: { projectId: true }, orderBy: { projectId: "asc" }, take: 1000 }),
        ]);
        const projects = groups.map(group => {
          const entry = { projectId: group.projectId };
          assertSafeEnvelope(entry);
          return projectQuerySchema.parse(entry).projectId!;
        });
        return buildSincDashboard(rows, total, projects, projectId ?? null);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch { throw new ServiceUnavailableException("Projeção Sinc indisponível"); }
  }
}
