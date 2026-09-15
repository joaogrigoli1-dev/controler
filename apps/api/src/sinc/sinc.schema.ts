import { createHash } from "node:crypto";
import { z } from "zod";

const secretId = /(?:^|[^a-z0-9])(?:sk|pk|rk|ghp|github_pat|xox[baprs]|AKIA)[_-][a-z0-9_-]{4,}/i;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]*$/).refine(value => !secretId.test(value) && !/^cpf[_-]?\d|^cnpj[_-]?\d/i.test(value) && ![11, 14].includes(value.replace(/\D/g, "").length));
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = z.string().regex(uuidPattern);
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = z.string().regex(instantPattern).refine(value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[9] ?? 0), offsetMinute = Number(match[10] ?? 0);
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0) && Number.isFinite(Date.parse(value));
});
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const forbiddenKeys = /prompt|conversation|transcript|reasoning|chain.of.thought|secret|password|token|cookie|authorization|credential|api.?key|command|code|path|email|phone|cpf|cnpj|address|name|log/i;
const forbiddenText = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bBearer\s+\S+|(?:^|\s)(?:\/|~\/|[A-Z]:[\\/])|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\(?\d{2}\)?\s?9?\d{4}[- ]?\d{4}/i;

export const SincProjectionEventSchema = z.object({
  event_version: z.literal("route-projection-event-v1"), event_id: uuid, idempotency_key: hash,
  project_id: id, entity_id: uuid, revision: z.number().int().min(1).max(1_000_000),
  occurred_at: instant,
  source: z.object({ kind: z.enum(["observer_f3", "pilot_f4", "projection_fixture"]), reference_id: hash, data_class: z.enum(["observed", "simulated"]) }).strict(),
  state: z.enum(["recommendation", "blocked", "integration_failure"]),
  route: z.object({ route_id: id, model_id: id, effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]) }).strict().nullable(),
  policy: z.object({ policy_id: id, decision_hash: hash }).strict(),
  metrics: z.object({ duration_ms: integer.nullable(), api_equivalent_cost_micros: integer.nullable(), observed_billed_cost_micros: integer.nullable(), currency: z.literal("USD") }).strict(),
}).strict().superRefine((event, ctx) => {
  if (event.state === "recommendation" && !event.route) ctx.addIssue({ code: "custom", message: "Envelope inválido" });
  if (event.source.data_class === "simulated" && event.metrics.observed_billed_cost_micros !== null) ctx.addIssue({ code: "custom", message: "Envelope inválido" });
});
export type SincEvent = z.infer<typeof SincProjectionEventSchema>;
export const SINC_BATCH_MAX_EVENTS = 100;
export const SINC_BATCH_MAX_BYTES = 64 * 1024;
const batchSchema = z.object({
  schema_version: z.literal("route-events-batch-v1"), batch_id: uuid, idempotency_key: hash,
  project_id: id, generated_at: instant,
  events: z.array(SincProjectionEventSchema).min(1).max(SINC_BATCH_MAX_EVENTS), batch_hash: hash,
}).strict();
export const projectQuerySchema = z.object({ projectId: id.optional() }).strict();

/** Fail before recursive schema validation, including unknown oversized keys. */
export function assertSafeEnvelope(input: unknown) {
  let size = 0, nodes = 0;
  const pending = [{ value: input, depth: 0 }];
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 8000 || depth > 8) throw new Error("Envelope inválido");
    if (typeof value === "string") {
      size += Buffer.byteLength(value);
      if (value.length > 128 || (!hash.safeParse(value).success && !uuidPattern.test(value) && !instantPattern.test(value) && forbiddenText.test(value))) throw new Error("Envelope inválido");
    } else if (value && typeof value === "object") {
      if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Envelope inválido");
      if (Object.values(Object.getOwnPropertyDescriptors(value)).some(descriptor => descriptor.get || descriptor.set)) throw new Error("Envelope inválido");
      const entries = Object.entries(value);
      if (entries.length > 100) throw new Error("Envelope inválido");
      for (const [key, child] of entries) {
        if (key.length > 64 || forbiddenKeys.test(key)) throw new Error("Envelope inválido");
        size += Buffer.byteLength(key);
        pending.push({ value: child, depth: depth + 1 });
      }
    }
    if (size > SINC_BATCH_MAX_BYTES) throw new Error("Envelope inválido");
  }
}
export function parseSincBatch(input: unknown) {
  assertSafeEnvelope(input);
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > SINC_BATCH_MAX_BYTES) throw new Error("Envelope inválido");
  const batch = batchSchema.parse(input);
  if (batch.events.some(event => event.project_id !== batch.project_id) || new Set(batch.events.map(event => event.event_id)).size !== batch.events.length || new Set(batch.events.map(event => event.idempotency_key)).size !== batch.events.length) throw new Error("Envelope inválido");
  const { batch_hash, ...body } = batch;
  if (canonicalHash(body) !== batch_hash) throw new Error("Envelope inválido");
  return batch;
}
export function canonicalHash(value: unknown): string {
  const canonical = (item: any): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") { if (!Number.isSafeInteger(item)) throw new Error("Valor não canônico"); return JSON.stringify(Object.is(item, -0) ? 0 : item); }
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item && typeof item === "object" && Object.getPrototypeOf(item) === Object.prototype) {
      if (Object.values(Object.getOwnPropertyDescriptors(item)).some(descriptor => descriptor.get || descriptor.set)) throw new Error("Valor não canônico");
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(",")}}`;
    }
    throw new Error("Valor não canônico");
  };
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
