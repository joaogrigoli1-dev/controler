import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { SincIngestGuard } from "../sinc/sinc-ingest.guard";
import { SincService } from "../sinc/sinc.service";
import { canonicalHash, SincProjectionEventSchema } from "../sinc/sinc.schema";
import { RoteadorController } from "./roteador.controller";
import { buildRoteadorDashboard, RoteadorDashboardService } from "./roteador-dashboard.service";
import { parseRouteDashboardSupplement, parseRouteDashboardSupplementBatch } from "./roteador.schema";

const FIXTURE = "/Users/jhgm/Dev/roteador/fixtures/dashboard/f6-transport.json";
const transport = JSON.parse(readFileSync(FIXTURE, "utf8"));
const rows = transport.events_batch.events.map((envelope: unknown, index: number) => ({ envelope, contentHash: canonicalHash(envelope), receivedAt: new Date(Date.UTC(2026, 8, 14, 19, index)) }));
const supplementRows = transport.supplements_batch.supplements.map((envelope: any, index: number) => ({ eventId: transport.events_batch.events[index].event_id, envelope, contentHash: canonicalHash(envelope), receivedAt: new Date(Date.UTC(2026, 8, 14, 20, index)) }));
function rehashSupplement(value: any) { const clone = structuredClone(value); delete clone.idempotency_key; return { ...clone, idempotency_key: canonicalHash(clone) }; }

describe("Roteador F6", () => {
  it("aceita o lote real do construtor Roteador e mantém o contrato cruzado", async () => {
    const source = await import(pathToFileURL("/Users/jhgm/Dev/roteador/packages/dashboard/index.mjs").href);
    expect(() => source.validateRouteDashboardSupplementBatch(transport.supplements_batch)).not.toThrow();
    expect(parseRouteDashboardSupplementBatch(transport.supplements_batch)).toEqual(transport.supplements_batch);
    expect(source.ALLOWED_DASHBOARD_RULE_IDS).toEqual(expect.arrayContaining(transport.supplements_batch.supplements.flatMap((item: any) => item.matched_rule_ids)));
  });

  it("rejeita IDs sensíveis, instantes impossíveis e estruturas hostis sem executar getters", () => {
    const base = transport.supplements_batch.supplements[0];
    for (const secret of ["sk_testsecret", "AKIAABCDEFGHIJKLMNOP", "ASIAABCDEFGHIJKLMNOP", "cpf_12345678901", "synthetic@example.test", "65999999999"]) {
      expect(() => parseRouteDashboardSupplement({ ...base, requested_model_id: secret })).toThrow();
    }
    expect(() => parseRouteDashboardSupplement({ ...base, supplement_id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" })).toThrow();
    expect(() => parseRouteDashboardSupplement({ ...base, occurred_at: "2026-09-14T12:00:00+14:01" })).toThrow();
    expect(() => parseRouteDashboardSupplement({ ...base, observed_model_id: "gpt-6-astra" })).toThrow();
    const evaluated = rehashSupplement({ ...base, observed_model_id: "gpt-6-astra", experiment: { ...base.experiment, state: "evaluated", functional_result: "passed", critical_failure: false } });
    expect(parseRouteDashboardSupplement(evaluated).experiment.candidate_cost_micros).toBeNull();
    let getterCalls = 0;
    const getter = { ...base }; Object.defineProperty(getter, "requested_model_id", { enumerable: true, get() { getterCalls++; return null; } });
    expect(() => parseRouteDashboardSupplement(getter)).toThrow(); expect(getterCalls).toBe(0);
    const hidden = { ...base }; Object.defineProperty(hidden, "hidden", { enumerable: false, value: "x" }); expect(() => parseRouteDashboardSupplement(hidden)).toThrow();
    const symbol = { ...base, [Symbol("x")]: "x" }; expect(() => parseRouteDashboardSupplement(symbol)).toThrow();
    const sparse: any[] = []; sparse.length = 1; expect(() => parseRouteDashboardSupplement({ ...base, matched_rule_ids: sparse })).toThrow();
    const custom: any = [...base.matched_rule_ids]; custom.extra = "x"; expect(() => parseRouteDashboardSupplement({ ...base, matched_rule_ids: custom })).toThrow();
    const inherited = Object.create({}); Object.assign(inherited, base); expect(() => parseRouteDashboardSupplement(inherited)).toThrow();
  });

  it("separa histórico e heads, origem, desconhecido, família e piloto preparado", () => {
    const events = transport.events_batch.events;
    const heads = events.filter((_: unknown, index: number) => index % 2 === 1).map((envelope: any) => ({ entityId: envelope.entity_id, revision: envelope.revision, eventId: envelope.event_id, event: rows[events.indexOf(envelope)] }));
    const dashboard = buildRoteadorDashboard(rows, heads, supplementRows, 1200, 8);
    expect(dashboard.overview.historyEvents).toBe(1200);
    expect(dashboard.overview.currentEntities).toBe(8);
    expect(dashboard.health.sampleLimited).toBe(true);
    expect(dashboard.health.gapStatus).toBe("partial_sample");
    expect(dashboard.metrics.simulated.eventCount).toBe(16);
    expect(dashboard.metrics.observed.eventCount).toBe(0);
    expect(dashboard.metrics.simulated.apiEquivalentCost.totalMicros).toBeNull();
    expect(dashboard.modelTree.find(group => group.family === "GPT")?.models.length).toBeGreaterThan(0);
    expect(dashboard.recentRoutes.filter(item => item.isCurrent)).toHaveLength(8);
    expect(dashboard.recentRoutes.every(item => item.explanation.status === "transported")).toBe(true);
    expect(dashboard.experiment).toMatchObject({ status: "prepared", plannedPairs: 8, executedPairs: 0, evaluatedPairs: 0, winner: null, pairedSavingsMicros: null });

    const base: any = events[0];
    const variants = [["gpt-6-astra", "85000000-0000-4000-8000-000000000001"], ["claude-opus-4", "85000000-0000-4000-8000-000000000002"], ["local-model", "85000000-0000-4000-8000-000000000003"]].map(([model, eventId], index) => ({ ...base, event_id: eventId, entity_id: `86000000-0000-4000-8000-00000000000${index + 1}`, route: { ...base.route, model_id: model } }));
    const familyRows = variants.map(envelope => ({ envelope, contentHash: canonicalHash(envelope), receivedAt: new Date() }));
    expect(buildRoteadorDashboard(familyRows, [], [], 3, 0).modelTree.map(group => group.family)).toEqual(["GPT", "Claude", "Outros"]);
  });

  it("preserva zero explícito e null, sem inventar suplemento ausente", () => {
    const original: any = transport.events_batch.events[0];
    const envelope = SincProjectionEventSchema.parse({ ...original, metrics: { ...original.metrics, duration_ms: 0, api_equivalent_cost_micros: 0 } });
    const dashboard = buildRoteadorDashboard([{ envelope, contentHash: canonicalHash(envelope), receivedAt: new Date() }], [{ entityId: envelope.entity_id, revision: envelope.revision, eventId: envelope.event_id, event: { envelope, contentHash: canonicalHash(envelope), receivedAt: new Date() } }], [], 1, 1);
    expect(dashboard.metrics.simulated.durationMs.p50).toBe(0);
    expect(dashboard.metrics.simulated.apiEquivalentCost.totalMicros).toBe("0");
    expect(dashboard.metrics.simulated.observedBilledCost.totalMicros).toBeNull();
    expect(dashboard.recentRoutes[0].explanation.status).toBe("not_transported");
    expect(dashboard.experiment.winner).toBeNull();
  });

  it("pareia somente braços correntes do mesmo experimento, contrato e critério", () => {
    const events: any[] = transport.events_batch.events.slice(0, 2);
    const localRows = events.map(envelope => ({ envelope, contentHash: canonicalHash(envelope), receivedAt: new Date() }));
    const heads = events.map((envelope, index) => ({ entityId: envelope.entity_id, revision: envelope.revision, eventId: envelope.event_id, event: localRows[index] }));
    const executed = transport.supplements_batch.supplements.slice(0, 2).map((item: any, index: number) => rehashSupplement({ ...item, observed_model_id: events[index].route.model_id, experiment: { ...item.experiment, state: "executed", functional_result: "passed", critical_failure: false } }));
    const asRows = (items: any[]) => items.map((envelope, index) => ({ eventId: events[index].event_id, envelope, contentHash: canonicalHash(envelope), receivedAt: new Date() }));
    expect(buildRoteadorDashboard(localRows, heads, asRows(executed), 2, 2).experiment.executedPairs).toBe(1);
    const divergent = [...executed]; divergent[1] = rehashSupplement({ ...divergent[1], contract_hash: `sha256:${"f".repeat(64)}` });
    expect(buildRoteadorDashboard(localRows, heads, asRows(divergent), 2, 2).experiment).toMatchObject({ plannedPairs: 2, executedPairs: 0 });
    const observedB = { ...events[1], source: { ...events[1].source, data_class: "observed" } };
    const mixedRows = [localRows[0], { envelope: observedB, contentHash: canonicalHash(observedB), receivedAt: new Date() }];
    const mixedHeads = [heads[0], { ...heads[1], event: mixedRows[1] }];
    expect(buildRoteadorDashboard(mixedRows, mixedHeads, asRows(executed), 2, 2).experiment).toMatchObject({ plannedPairs: 2, executedPairs: 0 });
    expect(buildRoteadorDashboard(localRows, heads.slice(0, 1), asRows(executed), 2, 1).experiment).toMatchObject({ status: "execution_incomplete", plannedPairs: 1, executedPairs: 0 });
  });

  it("expõe somente as rotas fixas e os guards definidos", () => {
    expect(Reflect.getMetadata(PATH_METADATA, RoteadorController.prototype.dashboard)).toBe("roteador/dashboard");
    expect(Reflect.getMetadata(PATH_METADATA, RoteadorController.prototype.ingestSupplements)).toBe("v1/roteador/dashboard-supplements/batch");
    expect(Reflect.getMetadata(GUARDS_METADATA, RoteadorController.prototype.dashboard)).toContain(JwtAuthGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, RoteadorController.prototype.ingestSupplements)).toContain(SincIngestGuard);
  });

  it("F5 recusa lote de outro projeto antes de abrir transação", async () => {
    const foreign = structuredClone(transport.events_batch);
    foreign.project_id = "outro";
    foreign.events = foreign.events.map((item: any) => ({ ...item, project_id: "outro" }));
    const { batch_hash: ignored, ...body } = foreign; void ignored;
    foreign.batch_hash = canonicalHash(body);
    const prisma = { $transaction: () => { throw new Error("não deveria abrir transação"); } };
    await expect(new SincService(prisma as any).ingest(foreign)).rejects.toThrow("Projeto de projeção inválido");
  });
});

const localUrl = process.env.SINC_TEST_DATABASE_URL;
describe.skipIf(!localUrl)("Roteador F6 em PostgreSQL real", () => {
  let prisma: PrismaClient, admin: PrismaClient;
  let sinc: SincService, service: RoteadorDashboardService;
  const schema = `roteador_f6_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    const url = new URL(localUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Teste exige PostgreSQL local");
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("schema", schema);
    prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    for (const path of ["prisma/migrations/20260914183000_sinc_projection/migration.sql", "prisma/migrations/20260915013000_route_dashboard_supplement/migration.sql"]) {
      for (const sql of readFileSync(path, "utf8").split(";").filter(part => part.trim())) await prisma.$executeRawUnsafe(sql);
    }
    sinc = new SincService(prisma as any); service = new RoteadorDashboardService(prisma as any);
  });
  afterAll(async () => { await prisma?.$disconnect(); if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); } });

  it("liga suplementos ao evento, reverte lote parcial e mantém replay idempotente", async () => {
    await sinc.ingest(transport.events_batch);
    const valid = structuredClone(transport.supplements_batch.supplements[0]);
    const missing = structuredClone(transport.supplements_batch.supplements[1]);
    missing.supplement_id = "87000000-0000-4000-8000-000000000001";
    missing.entity_id = "87000000-0000-4000-8000-000000000002";
    const { idempotency_key: oldKey, ...missingBody } = missing; void oldKey;
    missing.idempotency_key = canonicalHash(missingBody);
    const core = { schema_version: "route-dashboard-supplements-batch-v1", batch_id: "87000000-0000-4000-8000-000000000003", project_id: "roteador", generated_at: "2026-09-14T20:00:00-04:00", supplements: [valid, missing] };
    const idempotency_key = canonicalHash(core);
    const partial = { ...core, idempotency_key, batch_hash: canonicalHash({ ...core, idempotency_key }) };
    await expect(service.ingestSupplements(partial)).rejects.toThrow("Evento F5 vinculado não encontrado");
    expect(await prisma.routeDashboardSupplement.count()).toBe(0);
    expect(await service.ingestSupplements(transport.supplements_batch)).toMatchObject({ inserted: 16, replayed: 0, batchReplayed: false });
    expect(await service.ingestSupplements(transport.supplements_batch)).toMatchObject({ inserted: 0, replayed: 16, batchReplayed: true });
    expect(await prisma.routeDashboardSupplement.count()).toBe(16);
    const unsafe = structuredClone(transport.supplements_batch);
    unsafe.supplements[0].requested_model_id = "synthetic@example.test";
    await expect(service.ingestSupplements(unsafe)).rejects.toThrow("Lote de suplementos inválido");
    expect(await prisma.routeDashboardSupplement.count()).toBe(16);
    const dashboard = await service.dashboard();
    expect(dashboard.overview).toMatchObject({ historyEvents: 16, currentEntities: 16 });
    expect(dashboard.experiment).toMatchObject({ status: "prepared", plannedPairs: 8, winner: null });
  });
});
