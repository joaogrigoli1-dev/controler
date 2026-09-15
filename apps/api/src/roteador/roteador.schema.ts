import { z } from "zod";
import { canonicalHash, SINC_BATCH_MAX_BYTES, SINC_BATCH_MAX_EVENTS } from "../sinc/sinc.schema";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const secretId = /(?:^|[._:@-])(?:(?:AKIA|ASIA)[A-Z0-9]{16}|(?:sk|pk|rk|ghp|github_pat|xox[baprs])(?:[_-]?[A-Z0-9]){4,})(?:$|[._:@-])/i;
const forbiddenKeys = /(?:prompt|conversation|transcript|reasoning|chain.of.thought|secret|password|token|cookie|authorization|credential|api.?key|command|code|path|email|phone|cpf|cnpj|address|name|log)/i;
const forbiddenText = /(?:-----BEGIN [A-Z ]+PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~+/-]+=*|\b[A-Z]:\\|(?:^|\s)\/(?:Users|home|etc|var|tmp)\/|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\(?\d{2}\)?\s?9?\d{4}[- ]?\d{4})/i;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/).refine(value => {
  const digits = value.replace(/\D/g, "");
  return !secretId.test(value) && !/^cpf[_-]?\d/i.test(value) && !/^cnpj[_-]?\d/i.test(value) && digits.length !== 11 && digits.length !== 14;
});
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = z.string().regex(instantPattern).refine(value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const offsetHour = Number(match[9] ?? 0), offsetMinute = Number(match[10] ?? 0);
  return year >= 1000 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate() && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 14 && offsetMinute <= 59 && (offsetHour !== 14 || offsetMinute === 0) && Number.isFinite(Date.parse(value));
});
const metric = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();

function cloneDescriptorData(value: unknown, inspectText = true): any {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (inspectText && !hash.safeParse(value).success && !uuid.safeParse(value).success && !instantPattern.test(value) && forbiddenText.test(value)) throw new Error("Texto não permitido");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("Valor não canônico");
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") throw new Error("Tipo não canônico");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key === "symbol")) throw new Error("Chave não permitida");
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error("Array inválido");
    const length = descriptors.length?.value;
    const dataKeys = keys.filter((key): key is string => typeof key === "string" && key !== "length");
    if (!Number.isSafeInteger(length) || dataKeys.length !== length || dataKeys.some((key, index) => key !== String(index))) throw new Error("Array inválido");
    return dataKeys.map(key => {
      const descriptor = descriptors[key];
      if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error("Array inválido");
      return cloneDescriptorData(descriptor.value, inspectText);
    });
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Objeto inválido");
  const output: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    if (inspectText && forbiddenKeys.test(key)) throw new Error("Campo não permitido");
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error("Objeto inválido");
    Object.defineProperty(output, key, { value: cloneDescriptorData(descriptor.value, inspectText), enumerable: true, writable: true, configurable: true });
  }
  return output;
}

export const ALLOWED_DASHBOARD_RULE_IDS = [
  "AMBIGUITY_PRESENT", "AUTH_CHANGE", "BASELINE_UNAVAILABLE_RECORDED",
  "CAUSE_DISCOVERY_REQUIRED", "CROSS_MODULE", "DATABASE_CHANGE", "DEPENDENCY_DENSE",
  "ELIGIBILITY_AVAILABILITY_UNKNOWN", "ELIGIBILITY_CAPABILITY_MISSING",
  "ELIGIBILITY_CATALOG_STALE", "ELIGIBILITY_CONTEXT_INSUFFICIENT",
  "ELIGIBILITY_EFFORT_UNSUPPORTED", "ELIGIBILITY_INTEGRATION_UNSUPPORTED",
  "ELIGIBILITY_PAID_API_DISABLED", "ELIGIBILITY_PRICE_SOURCE_MISSING",
  "ELIGIBILITY_PRICE_STALE", "ELIGIBILITY_PRIVACY_INCOMPATIBLE",
  "ELIGIBILITY_QUOTA_BLOCK_THRESHOLD", "ELIGIBILITY_QUOTA_EXHAUSTED",
  "ELIGIBILITY_QUOTA_SNAPSHOT_MISSING", "ELIGIBILITY_QUOTA_STALE",
  "ELIGIBILITY_QUOTA_UNKNOWN", "ELIGIBILITY_UNAVAILABLE", "EMPIRICAL_POLICY_APPLIED",
  "EVIDENCE_WEAK", "EXTERNAL_EFFECTS", "HAS_DEPENDENCIES", "MULTI_MODULE",
  "OBJECTIVE_SIGNALS_LOW", "OBSERVER_MODE_NO_EXECUTION_CHANGE",
  "POLICY_COMBINATION_UNAVAILABLE_ASTRA_MEDIUM", "POLICY_CRITICAL_ASTRA_FLOOR",
  "POLICY_CRITICAL_PROFILE_UNAVAILABLE", "POLICY_EMPIRICAL_EVIDENCE_NOT_CLAIMED",
  "POLICY_HIGH_COMPLEXITY_ASTRA", "POLICY_HIGH_RISK_ASTRA", "POLICY_LOW_COMPLEXITY_LUNA",
  "POLICY_MEDIUM_COMPLEXITY_TERRA", "POLICY_MEDIUM_RISK_TERRA", "POLICY_MEDIUM_SOL",
  "PRODUCTION_CHANGE", "REGRESSION_RISK", "SAFE_BASELINE_SELECTED", "SECURITY_CHANGE",
] as const;

export const RouteDashboardSupplementSchema = z.object({
  supplement_version: z.literal("route-dashboard-supplement-v1"),
  supplement_id: uuid,
  idempotency_key: hash,
  project_id: z.literal("roteador"),
  entity_id: uuid,
  revision: z.number().int().min(1).max(1_000_000),
  decision_hash: hash,
  occurred_at: instant,
  matched_rule_ids: z.array(z.enum(ALLOWED_DASHBOARD_RULE_IDS)).max(32).refine(values => new Set(values).size === values.length),
  requested_model_id: id.nullable(),
  observed_model_id: id.nullable(),
  experiment: z.object({
    experiment_id: id,
    pair_id: uuid,
    arm: z.enum(["A", "B"]),
    state: z.enum(["prepared", "executed", "evaluated"]),
    functional_result: z.enum(["passed", "failed"]).nullable(),
    critical_failure: z.boolean().nullable(),
    baseline_cost_micros: metric,
    candidate_cost_micros: metric,
    quality_score_basis_points: z.number().int().min(0).max(10_000).nullable(),
  }).strict(),
  contract_hash: hash,
  criteria_hash: hash,
}).strict().superRefine((value, ctx) => {
  const resultFields = [value.experiment.functional_result, value.experiment.critical_failure, value.experiment.baseline_cost_micros, value.experiment.candidate_cost_micros, value.experiment.quality_score_basis_points];
  if (value.experiment.state === "prepared" && (value.observed_model_id !== null || resultFields.some(item => item !== null))) ctx.addIssue({ code: "custom", message: "Suplemento inválido" });
  if (value.experiment.state !== "prepared" && (value.experiment.functional_result === null || value.experiment.critical_failure === null)) ctx.addIssue({ code: "custom", message: "Suplemento inválido" });
  const { idempotency_key, ...body } = value;
  if (canonicalHash(body) !== idempotency_key) ctx.addIssue({ code: "custom", message: "Suplemento inválido" });
});
export type RouteDashboardSupplement = z.infer<typeof RouteDashboardSupplementSchema>;

const RouteDashboardSupplementBatchSchema = z.object({
  schema_version: z.literal("route-dashboard-supplements-batch-v1"),
  batch_id: uuid,
  idempotency_key: hash,
  project_id: z.literal("roteador"),
  generated_at: instant,
  supplements: z.array(RouteDashboardSupplementSchema).min(1).max(SINC_BATCH_MAX_EVENTS),
  batch_hash: hash,
}).strict();

export function parseRouteDashboardSupplement(input: unknown) {
  const value = RouteDashboardSupplementSchema.parse(cloneDescriptorData(input));
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > SINC_BATCH_MAX_BYTES) throw new Error("Suplemento inválido");
  return value;
}

export function parseRouteDashboardSupplementBatch(input: unknown) {
  const safe = cloneDescriptorData(input);
  if (Buffer.byteLength(JSON.stringify(safe), "utf8") > SINC_BATCH_MAX_BYTES) throw new Error("Lote inválido");
  const batch = RouteDashboardSupplementBatchSchema.parse(safe);
  if (new Set(batch.supplements.map(item => item.supplement_id)).size !== batch.supplements.length || new Set(batch.supplements.map(item => item.idempotency_key)).size !== batch.supplements.length) throw new Error("Lote inválido");
  const logicalLinks = batch.supplements.map(item => `${item.project_id}\0${item.entity_id}\0${item.revision}\0${item.decision_hash}`);
  if (new Set(logicalLinks).size !== logicalLinks.length) throw new Error("Lote inválido");
  const { batch_hash, idempotency_key, ...core } = batch;
  if (canonicalHash(core) !== idempotency_key || canonicalHash({ ...core, idempotency_key }) !== batch_hash) throw new Error("Lote inválido");
  return batch;
}
