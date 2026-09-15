import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../common/prisma.service";
import { assertSafeEnvelope, canonicalHash, SincEvent, SincProjectionEventSchema } from "../sinc/sinc.schema";
import { parseRouteDashboardSupplement, parseRouteDashboardSupplementBatch, RouteDashboardSupplement } from "./roteador.schema";

export const ROTEADOR_PROJECT_ID = "roteador";
export const ROTEADOR_DASHBOARD_SAMPLE_LIMIT = 1000;

type ProjectionRow = { envelope: unknown; contentHash: string; receivedAt: Date };
type HeadRow = { entityId: string; revision: number; eventId: string; event: ProjectionRow };
type SupplementRow = { eventId: string; envelope: unknown; contentHash: string; receivedAt: Date };

function familyOf(modelId: string): "GPT" | "Claude" | "Outros" {
  const id = modelId.toLowerCase();
  if (id.startsWith("gpt-") || id.startsWith("openai.")) return "GPT";
  if (id.startsWith("claude-") || id.startsWith("anthropic.")) return "Claude";
  return "Outros";
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.ceil(ordered.length * p) - 1];
}

function metric(values: Array<number | null>) {
  const known = values.filter((value): value is number => value !== null);
  return {
    knownCount: known.length,
    unknownCount: values.length - known.length,
    knownSumMicros: known.reduce((sum, value) => sum + BigInt(value), 0n).toString(),
    totalMicros: values.length > 0 && known.length === values.length ? known.reduce((sum, value) => sum + BigInt(value), 0n).toString() : null,
  };
}

function groupMetrics(events: SincEvent[]) {
  const durations = events.map(event => event.metrics.duration_ms);
  const knownDurations = durations.filter((value): value is number => value !== null);
  return {
    eventCount: events.length,
    durationMs: { knownCount: knownDurations.length, unknownCount: durations.length - knownDurations.length, p50: percentile(knownDurations, .5), p95: percentile(knownDurations, .95) },
    apiEquivalentCost: metric(events.map(event => event.metrics.api_equivalent_cost_micros)),
    observedBilledCost: metric(events.map(event => event.metrics.observed_billed_cost_micros)),
  };
}

function parseProjection(row: ProjectionRow) {
  assertSafeEnvelope(row.envelope);
  const event = SincProjectionEventSchema.parse(row.envelope);
  if (event.project_id !== ROTEADOR_PROJECT_ID || canonicalHash(event) !== row.contentHash) throw new Error("Projeção inválida");
  return event;
}

function parseSupplement(row: SupplementRow) {
  assertSafeEnvelope(row.envelope);
  const value = parseRouteDashboardSupplement(row.envelope);
  if (canonicalHash(value) !== row.contentHash) throw new Error("Suplemento inválido");
  return value;
}

/** Pure projection builder: history and current heads remain explicitly separate. */
export function buildRoteadorDashboard(historyRows: ProjectionRow[], headRows: HeadRow[], supplementRows: SupplementRow[], totalHistory: number, totalHeads: number) {
  const history = historyRows.map(parseProjection);
  const heads = headRows.map(row => {
    const event = parseProjection(row.event);
    if (event.event_id !== row.eventId || event.entity_id !== row.entityId || event.revision !== row.revision) throw new Error("Head inválido");
    return event;
  });
  const supplements = supplementRows.map(row => ({ eventId: row.eventId, value: parseSupplement(row), receivedAt: row.receivedAt }));
  const supplementByEvent = new Map(supplements.map(item => [item.eventId, item.value]));
  const headIds = new Set(heads.map(event => event.event_id));
  const headById = new Map(heads.map(event => [event.event_id, event]));

  const modelMap = new Map<string, { family: "GPT" | "Claude" | "Outros"; modelId: string; effort: string; observed: number; simulated: number; total: number }>();
  for (const event of history) {
    if (!event.route) continue;
    const key = JSON.stringify([event.route.model_id, event.route.effort]);
    const group = modelMap.get(key) ?? { family: familyOf(event.route.model_id), modelId: event.route.model_id, effort: event.route.effort, observed: 0, simulated: 0, total: 0 };
    group[event.source.data_class]++;
    group.total++;
    modelMap.set(key, group);
  }
  const families = (["GPT", "Claude", "Outros"] as const).map(family => ({
    family,
    models: [...modelMap.values()].filter(item => item.family === family).sort((a, b) => a.modelId.localeCompare(b.modelId) || a.effort.localeCompare(b.effort)),
  })).filter(group => group.models.length > 0);

  const revisions = new Map<string, number[]>();
  for (const event of history) revisions.set(event.entity_id, [...(revisions.get(event.entity_id) ?? []), event.revision]);
  let detectedRevisionGaps = 0;
  for (const values of revisions.values()) {
    const ordered = [...new Set(values)].sort((a, b) => a - b);
    for (let index = 1; index < ordered.length; index++) detectedRevisionGaps += Math.max(0, ordered[index] - ordered[index - 1] - 1);
  }
  const sampleLimited = totalHistory > history.length;
  const latestOccurredAt = history.length ? history.reduce((latest, event) => Date.parse(event.occurred_at) > Date.parse(latest) ? event.occurred_at : latest, history[0].occurred_at) : null;

  const pairs = new Map<string, RouteDashboardSupplement[]>();
  for (const { eventId, value } of supplements) {
    if (!headIds.has(eventId)) continue;
    const key = JSON.stringify([value.experiment.experiment_id, value.experiment.pair_id, value.contract_hash, value.criteria_hash, headById.get(eventId)!.source.data_class]);
    pairs.set(key, [...(pairs.get(key) ?? []), value]);
  }
  const executedPairs = [...pairs.values()].filter(items => new Set(items.filter(item => item.experiment.state !== "prepared").map(item => item.experiment.arm)).size === 2).length;
  const evaluatedPairs = [...pairs.values()].filter(items => new Set(items.filter(item => item.experiment.state === "evaluated").map(item => item.experiment.arm)).size === 2).length;
  const hasStartedExperiment = [...pairs.values()].some(items => items.some(item => item.experiment.state !== "prepared"));

  return {
    generatedAt: new Date().toISOString(),
    source: "postgres_projection" as const,
    authority: "informational_only" as const,
    projectId: ROTEADOR_PROJECT_ID,
    state: history.length ? "available" as const : "empty" as const,
    overview: {
      historyEvents: totalHistory,
      currentEntities: totalHeads,
      recommendations: history.filter(event => event.state === "recommendation").length,
      blocked: history.filter(event => event.state === "blocked").length,
      integrationFailures: history.filter(event => event.state === "integration_failure").length,
      currentStates: {
        recommendations: heads.filter(event => event.state === "recommendation").length,
        blocked: heads.filter(event => event.state === "blocked").length,
        integrationFailures: heads.filter(event => event.state === "integration_failure").length,
      },
    },
    metrics: {
      observed: groupMetrics(history.filter(event => event.source.data_class === "observed")),
      simulated: groupMetrics(history.filter(event => event.source.data_class === "simulated")),
    },
    recentRoutes: history.slice(0, 50).map(event => {
      const supplement = supplementByEvent.get(event.event_id);
      return {
        eventId: event.event_id, entityId: event.entity_id, revision: event.revision, occurredAt: event.occurred_at,
        state: event.state, route: event.route, policyId: event.policy.policy_id, decisionHash: event.policy.decision_hash,
        dataClass: event.source.data_class, durationMs: event.metrics.duration_ms, isCurrent: headIds.has(event.event_id),
        explanation: supplement ? { status: "transported" as const, matchedRuleIds: supplement.matched_rule_ids } : { status: "not_transported" as const, matchedRuleIds: [] },
      };
    }),
    modelTree: families,
    experiment: {
      status: supplements.length ? (evaluatedPairs > 0 ? "partially_measured" as const : executedPairs > 0 || hasStartedExperiment ? "execution_incomplete" as const : "prepared" as const) : "not_transported" as const,
      plannedPairs: pairs.size, executedPairs, evaluatedPairs,
      functionalApprovalRate: null, criticalFailureRate: null, pairedSavingsMicros: null, winner: null,
    },
    health: {
      sampleLimit: ROTEADOR_DASHBOARD_SAMPLE_LIMIT, sampleLimited, sampledEvents: history.length, totalStoredEvents: totalHistory,
      totalCurrentEntities: totalHeads, latestOccurredAt,
      latestReceivedAt: historyRows.length ? new Date(Math.max(...historyRows.map(row => row.receivedAt.getTime()))).toISOString() : null,
      lagSeconds: latestOccurredAt ? Math.max(0, Math.floor((Date.now() - Date.parse(latestOccurredAt)) / 1000)) : null,
      detectedRevisionGaps,
      gapStatus: sampleLimited ? "partial_sample" as const : detectedRevisionGaps > 0 ? "detected" as const : "none_detected" as const,
    },
  };
}

@Injectable()
export class RoteadorDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async ingestSupplements(input: unknown) {
    let batch: ReturnType<typeof parseRouteDashboardSupplementBatch>;
    try { batch = parseRouteDashboardSupplementBatch(input); }
    catch { throw new BadRequestException("Lote de suplementos inválido"); }
    try {
      return await this.prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT 1 AS acquired FROM pg_advisory_xact_lock(1936289380)`;
        const prior = await tx.routeDashboardSupplementBatch.findMany({ where: { OR: [{ batchId: batch.batch_id }, { idempotencyKey: batch.idempotency_key }] } });
        if (prior.length) {
          if (prior.length !== 1 || prior[0].batchId !== batch.batch_id || prior[0].idempotencyKey !== batch.idempotency_key || prior[0].contentHash !== batch.batch_hash) throw new ConflictException("Conflito de idempotência do suplemento");
          return { status: "accepted" as const, inserted: 0, replayed: prior[0].itemCount, batchReplayed: true, batchHash: batch.batch_hash, authority: "informational_only" as const };
        }
        let inserted = 0, replayed = 0;
        for (const supplement of batch.supplements) {
          const event = await tx.sincProjectionEvent.findUnique({ where: { projectId_entityId_revision: { projectId: supplement.project_id, entityId: supplement.entity_id, revision: supplement.revision } }, select: { eventId: true, envelope: true } });
          if (!event) throw new BadRequestException("Evento F5 vinculado não encontrado");
          const projection = SincProjectionEventSchema.parse(event.envelope);
          if (projection.policy.decision_hash !== supplement.decision_hash || Date.parse(projection.occurred_at) !== Date.parse(supplement.occurred_at)) throw new ConflictException("Vínculo do suplemento divergente");
          const contentHash = canonicalHash(supplement);
          const matches = await tx.routeDashboardSupplement.findMany({ where: { OR: [
            { supplementId: supplement.supplement_id }, { idempotencyKey: supplement.idempotency_key },
            { projectId: supplement.project_id, entityId: supplement.entity_id, revision: supplement.revision },
          ] } });
          if (matches.length) {
            if (matches.length !== 1 || matches[0].supplementId !== supplement.supplement_id || matches[0].idempotencyKey !== supplement.idempotency_key || matches[0].contentHash !== contentHash || matches[0].eventId !== event.eventId) throw new ConflictException("Conflito de idempotência do suplemento");
            replayed++;
            continue;
          }
          await tx.routeDashboardSupplement.create({ data: {
            supplementId: supplement.supplement_id, idempotencyKey: supplement.idempotency_key,
            projectId: supplement.project_id, entityId: supplement.entity_id, revision: supplement.revision,
            decisionHash: supplement.decision_hash, eventId: event.eventId, contentHash,
            occurredAt: new Date(supplement.occurred_at), envelope: supplement as Prisma.InputJsonValue,
          } });
          inserted++;
        }
        await tx.routeDashboardSupplementBatch.create({ data: {
          batchId: batch.batch_id, idempotencyKey: batch.idempotency_key, projectId: batch.project_id,
          contentHash: batch.batch_hash, generatedAt: new Date(batch.generated_at), itemCount: batch.supplements.length,
        } });
        return { status: "accepted" as const, inserted, replayed, batchReplayed: false, batchHash: batch.batch_hash, authority: "informational_only" as const };
      }, { maxWait: 5000, timeout: 15000 });
    } catch (error) {
      if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
      throw new ServiceUnavailableException("Projeção de suplementos indisponível");
    }
  }

  async dashboard() {
    try {
      return await this.prisma.$transaction(async tx => {
        const [history, heads, supplements, totalHistory, totalHeads] = await Promise.all([
          tx.sincProjectionEvent.findMany({ where: { projectId: ROTEADOR_PROJECT_ID }, orderBy: [{ occurredAt: "desc" }, { eventId: "asc" }], take: ROTEADOR_DASHBOARD_SAMPLE_LIMIT, select: { envelope: true, contentHash: true, receivedAt: true } }),
          tx.sincProjectionHead.findMany({ where: { projectId: ROTEADOR_PROJECT_ID }, orderBy: { entityId: "asc" }, include: { event: { select: { envelope: true, contentHash: true, receivedAt: true } } } }),
          tx.routeDashboardSupplement.findMany({ where: { projectId: ROTEADOR_PROJECT_ID }, orderBy: [{ occurredAt: "desc" }, { supplementId: "asc" }], take: ROTEADOR_DASHBOARD_SAMPLE_LIMIT, select: { eventId: true, envelope: true, contentHash: true, receivedAt: true } }),
          tx.sincProjectionEvent.count({ where: { projectId: ROTEADOR_PROJECT_ID } }),
          tx.sincProjectionHead.count({ where: { projectId: ROTEADOR_PROJECT_ID } }),
        ]);
        return buildRoteadorDashboard(history, heads, supplements, totalHistory, totalHeads);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch {
      throw new ServiceUnavailableException("Dashboard do Roteador indisponível");
    }
  }
}
