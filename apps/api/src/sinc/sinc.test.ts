import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../common/prisma.service";
import { hmacHash } from "../common/crypto.util";
import { ConfigService } from "@nestjs/config";
import { GUARDS_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { SincController } from "./sinc.controller";
import { SincIngestGuard } from "./sinc-ingest.guard";
import { SincService, buildSincDashboard } from "./sinc.service";
import { canonicalHash, parseSincBatch as parseRouteBatch } from "./sinc.schema";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";

function opaque(value: string) {
  const h = canonicalHash(value).slice(7);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function batch(input: { events: unknown[] }, overrides: Record<string, unknown> = {}) {
  const body = { schema_version: "route-events-batch-v1", batch_id: opaque(canonicalHash(input)), idempotency_key: canonicalHash(input), project_id: "roteador", generated_at: "2026-09-14T12:00:00Z", ...input, ...overrides };
  return { ...body, batch_hash: canonicalHash(body) };
}
const parseSincBatch = (input: any) => parseRouteBatch(batch(input)).events;
function event(overrides: Record<string, unknown> = {}) {
  return {
    event_version: "route-projection-event-v1", event_id: opaque("event-first"), idempotency_key: canonicalHash("key-first"),
    project_id: "roteador", entity_id: opaque("entity-first"), revision: 1, occurred_at: "2026-09-14T12:00:00Z",
    source: { kind: "pilot_f4", reference_id: canonicalHash("ref-first"), data_class: "simulated" }, state: "recommendation",
    route: { route_id: "route-first", model_id: "model-first", effort: "high" },
    policy: { policy_id: "policy-first", decision_hash: `sha256:${"c".repeat(64)}` },
    metrics: { duration_ms: 25, api_equivalent_cost_micros: 1500, observed_billed_cost_micros: null, currency: "USD" }, ...overrides,
  };
}

it("F5 estrito recusa campos proibidos, texto sensível, arrays/tamanho/profundidade e incoerências", () => {
  expect(parseSincBatch({ events: [event()] })).toHaveLength(1);
  for (const field of ["prompt", "conversation", "transcript", "reasoning", "secret", "token", "command", "code", "path", "email", "phone", "cpf", "cnpj", "address", "name", "log"]) {
    expect(() => parseSincBatch({ events: [event({ [field]: "sensitive-marker" })] })).toThrow();
    expect(() => parseSincBatch({ events: [event({ source: { ...event().source, [field]: "sensitive-marker" } })] })).toThrow();
  }
  for (const value of ["/opt/private", "C:\\private", "Bearer secret-marker", "-----BEGIN PRIVATE KEY-----", "synthetic@example.test", "123.456.789-00", "11999999999", "x".repeat(10000)]) {
    expect(() => parseSincBatch({ events: [event({ entity_id: value })] })).toThrow();
  }
  expect(() => parseSincBatch({ events: [event({ route: null })] })).toThrow();
  expect(() => parseSincBatch({ events: [event({ metrics: { ...event().metrics, observed_billed_cost_micros: 0 } })] })).toThrow();
  expect(() => parseSincBatch({ events: Array(101).fill(event()) })).toThrow();
  expect(() => parseSincBatch({ events: [event(), event()] })).toThrow();
  expect(() => parseSincBatch({ events: [event({ project_id: "other" })] })).toThrow();
  expect(() => parseSincBatch({ events: [event({ occurred_at: "2026-02-30T12:00:00Z" })] })).toThrow();
  expect(() => parseSincBatch({ events: [event({ occurred_at: "2026-09-14T12:00:00+14:01" })] })).toThrow();
  expect(() => parseSincBatch({ events: [event({ project_id: "sk-testsecret" })] })).toThrow();
  expect(parseSincBatch({ events: [event({ metrics: { ...event().metrics, duration_ms: null } })] })[0].metrics.duration_ms).toBeNull();
  expect(() => parseRouteBatch({ events: [event()] })).toThrow();
  expect(() => parseRouteBatch({ ...batch({ events: [event()] }), batch_hash: canonicalHash("wrong") })).toThrow();
  const oversized = batch({ events: Array.from({ length: 100 }, (_, index) => event({ event_id: opaque(`event-${index}`), entity_id: opaque(`entity-${index}`), idempotency_key: canonicalHash(`key-${index}`), route: { route_id: "r".repeat(128), model_id: "m".repeat(128), effort: "high" } })) });
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(64 * 1024);
  expect(() => parseRouteBatch(oversized)).toThrow();
  expect(() => parseSincBatch({ events: [event(), event({ event_id: opaque("another") })] })).toThrow();
  let deep: any = "x"; for (let i = 0; i < 100; i++) deep = { nested: deep };
  expect(() => parseSincBatch(deep)).toThrow();
});

it("custos desconhecidos permanecem null e painel vazio não afirma zero de cobrança", () => {
  const empty = buildSincDashboard([], 0, [], null);
  expect(empty.state).toBe("empty");
  expect(empty.integration.evidenceKind).toBe("last_measured");
  expect(empty.integration.measuredAt).toBe("2026-09-14T20:18:00-04:00");
  expect(empty.integration.contract.status).toBe("prepared");
  expect(empty.health.latestReceivedAt).toBeNull();
  expect(empty.overview.apiEquivalentCost.totalMicros).toBeNull();
  const value = event();
  const dashboard = buildSincDashboard([{ envelope: value, contentHash: canonicalHash(value), receivedAt: new Date() }], 1500, ["roteador"], "roteador");
  expect(dashboard.health.sampleLimited).toBe(true);
  expect(dashboard.overview.observedBilledCost.totalMicros).toBeNull();
  expect(dashboard.overview.observedBilledCost.unknownCount).toBe(1);
  expect(dashboard.overview.apiEquivalentCost.totalMicros).toBe("1500");
  expect(dashboard.authority).toBe("informational_only");
  expect(() => buildSincDashboard([{ envelope: value, contentHash: "invalid", receivedAt: new Date() }], 1, [], null)).toThrow();
});

it("ingest usa chave exclusiva timing-safe e dashboard declara JwtAuthGuard", () => {
  const key = randomBytes(32).toString("hex");
  const guard = new SincIngestGuard(new ConfigService({ SINC_INGEST_TOKEN: key }));
  const ctx = (value: unknown) => ({ switchToHttp: () => ({ getRequest: () => ({ headers: { "x-sinc-ingest-token": value } }) }) } as any);
  expect(guard.canActivate(ctx(key))).toBe(true);
  for (const bad of [undefined, [key], key.slice(1), "Bearer " + key, "x".repeat(1000)]) expect(() => guard.canActivate(ctx(bad))).toThrow("Ingestão não autorizada");
  expect(() => new SincIngestGuard(new ConfigService({})).canActivate(ctx(key))).toThrow();
  expect(() => new SincIngestGuard(new ConfigService({ SINC_INGEST_TOKEN: key, JWT_ACCESS_SECRET: key })).canActivate(ctx(key))).toThrow();
  expect(Reflect.getMetadata(GUARDS_METADATA, SincController.prototype.dashboard)).toContain(JwtAuthGuard);
  expect(Reflect.getMetadata(GUARDS_METADATA, SincController.prototype.ingest)).toContain(SincIngestGuard);
  expect(Reflect.getMetadata(PATH_METADATA, SincController.prototype.ingest)).toBe("v1/roteador/events/batch");
});

const localUrl = process.env.SINC_TEST_DATABASE_URL;
describe.skipIf(!localUrl)("Postgres real: transação, replay, concorrência, heads e reinício", () => {
  let prisma: PrismaClient;
  let admin: PrismaClient;
  let service: SincService;
  let databaseUrl: string;
  const ingest = (input: any) => service.ingest(batch(input));
  const schema = `sinc_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    const url = new URL(localUrl!);
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Teste exige Postgres local");
    admin = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    await admin.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    url.searchParams.set("schema", schema); databaseUrl = url.toString();
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    const migration = readFileSync("prisma/migrations/20260914183000_sinc_projection/migration.sql", "utf8");
    for (const sql of migration.split(";").filter(part => part.trim())) await prisma.$executeRawUnsafe(sql);
    service = new SincService(prisma as any);
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    if (admin) { await admin.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`); await admin.$disconnect(); }
  });
  it("empty, inserção/replay, conflito atômico e chegada atrasada", async () => {
    expect((await service.dashboard({})).state).toBe("empty");
    const first = event();
    expect(await ingest({ events: [first] })).toMatchObject({ inserted: 1, replayed: 0 });
    expect(await ingest({ events: [first] })).toMatchObject({ inserted: 0, replayed: 1, batchReplayed: true });
    expect(await service.ingest(batch({ events: [first] }, { batch_id: opaque("another-batch"), idempotency_key: canonicalHash("another-batch") }))).toMatchObject({ inserted: 0, replayed: 1, batchReplayed: false });
    await expect(ingest({ events: [event({ event_id: opaque("event-rollback"), idempotency_key: canonicalHash("key-rollback"), entity_id: opaque("entity-rollback") }), event({ state: "blocked" })] })).rejects.toThrow("Conflito de idempotência");
    expect(await prisma.sincProjectionEvent.count()).toBe(1);
    const third = event({ revision: 3, event_id: opaque("event-third"), idempotency_key: canonicalHash("key-third") });
    const second = event({ revision: 2, event_id: opaque("event-second"), idempotency_key: canonicalHash("key-second") });
    await ingest({ events: [third, second] });
    expect((await prisma.sincProjectionHead.findFirst())?.revision).toBe(3);
    const concurrent = event({ event_id: opaque("event-concurrent"), idempotency_key: canonicalHash("key-concurrent"), entity_id: opaque("entity-concurrent") });
    const outputs = await Promise.all([ingest({ events: [concurrent] }), ingest({ events: [concurrent] })]);
    expect(outputs.map(out => out.inserted).sort()).toEqual([0, 1]);
    expect(outputs.map(out => out.replayed).sort()).toEqual([0, 1]);
    expect(outputs.map(out => out.batchReplayed).sort()).toEqual([false, true]);
    const reusable = batch({ events: [concurrent] });
    await expect(service.ingest({ ...reusable, batch_hash: canonicalHash("drift") })).rejects.toThrow("Envelope Sinc inválido");
    const changed = { ...reusable, generated_at: "2026-09-14T12:01:00Z" }; delete changed.batch_hash;
    await expect(service.ingest({ ...changed, batch_hash: canonicalHash(changed) })).rejects.toThrow("Conflito de idempotência");
    await expect(ingest({ events: [event({ event_id: opaque("new-id"), idempotency_key: canonicalHash("new-key") })] })).rejects.toThrow("Conflito de idempotência");
    const restarted = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    try {
      const dashboard = await new SincService(restarted as any).dashboard({ projectId: "roteador" });
      expect(dashboard.overview.totalEvents).toBe(4);
      expect(dashboard.overview.observedBilledCost.totalMicros).toBeNull();
      expect((await new SincService(restarted as any).dashboard({ projectId: "other" })).state).toBe("empty");
    } finally { await restarted.$disconnect(); }
  });
  it("HTTP real: ingest rejeita JWT/sem chave, dashboard exige JWT/sessão e erros não refletem entrada", async () => {
    const oldSecret = process.env.JWT_ACCESS_SECRET;
    const secret = randomBytes(32).toString("hex");
    const ingestKey = randomBytes(32).toString("hex");
    process.env.JWT_ACCESS_SECRET = secret;
    const jwt = new JwtService();
    const token = jwt.sign({ sub: "synthetic-user", role: "viewer" }, { secret, expiresIn: "5m" });
    const sessionStore = { session: { findUnique: async ({ where }: any) => where.tokenHash === hmacHash(token) ? { id: "synthetic-session", status: "active", expiresAt: new Date(Date.now() + 60_000) } : null, update: async () => ({}) } };
    // Vitest/esbuild does not emit the metadata produced by the production tsc build.
    Reflect.defineMetadata("design:paramtypes", [JwtService, PrismaService], JwtAuthGuard);
    @Module({ controllers: [SincController], providers: [
      { provide: SincService, useValue: service },
      { provide: ConfigService, useValue: new ConfigService({ SINC_INGEST_TOKEN: ingestKey }) },
      { provide: JwtService, useValue: jwt },
      { provide: PrismaService, useValue: sessionStore },
      { provide: SincIngestGuard, useValue: new SincIngestGuard(new ConfigService({ SINC_INGEST_TOKEN: ingestKey })) },
      { provide: JwtAuthGuard, useValue: new JwtAuthGuard(jwt, sessionStore as any) },
    ] })
    class HttpTestModule {}
    const app = await NestFactory.create<NestFastifyApplication>(HttpTestModule, new FastifyAdapter(), { logger: false });
    try {
      app.setGlobalPrefix("api"); await app.init(); await app.getHttpAdapter().getInstance().ready();
      const http = app.getHttpAdapter().getInstance();
      const path = "/api/v1/roteador/events/batch";
      expect((await http.inject({ method: "GET", url: "/api/sinc/dashboard" })).statusCode).toBe(401);
      expect((await http.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${token}` }, payload: batch({ events: [event()] }) })).statusCode).toBe(401);
      expect((await http.inject({ method: "POST", url: path, headers: { "x-sinc-ingest-token": ingestKey }, payload: batch({ events: [event()] }) })).statusCode).toBe(201);
      const invalid = await http.inject({ method: "POST", url: path, headers: { "x-sinc-ingest-token": ingestKey }, payload: batch({ events: [event({ prompt: "sensitive-marker" })] }) });
      expect(invalid.statusCode).toBe(400); expect(invalid.body).not.toContain("sensitive-marker");
      const dashboard = await http.inject({ method: "GET", url: "/api/sinc/dashboard?projectId=roteador", headers: { authorization: `Bearer ${token}` } });
      expect(dashboard.statusCode).toBe(200); expect(dashboard.json().authority).toBe("informational_only");
      const empty = await http.inject({ method: "GET", url: "/api/sinc/dashboard?projectId=unknown", headers: { authorization: `Bearer ${token}` } });
      expect(empty.statusCode).toBe(200); expect(empty.json().state).toBe("empty");
    } finally { await app.close(); if (oldSecret === undefined) delete process.env.JWT_ACCESS_SECRET; else process.env.JWT_ACCESS_SECRET = oldSecret; }
  });

});
