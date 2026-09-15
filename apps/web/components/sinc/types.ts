// Read-only DTO for GET /sinc/dashboard. No execution/acceptance authority.
export interface ProjectionEvent {
  event_id: string;
  project_id: string;
  occurred_at: string;
  source: { kind: "observer_f3" | "pilot_f4" | "projection_fixture"; data_class: "observed" | "simulated" };
  state: "recommendation" | "blocked" | "integration_failure";
  route: { route_id: string; model_id: string; effort: string } | null;
  metrics: { duration_ms: number | null; api_equivalent_cost_micros: number | null; observed_billed_cost_micros: number | null; currency: "USD" };
}
export interface CostAggregate {
  currency: "USD";
  knownCount: number;
  unknownCount: number;
  knownSumMicros: string;
  totalMicros: string | null;
}
export interface Dashboard {
  integration?: {
    evidenceKind: "last_measured";
    measuredAt: string;
    clients: Array<{ client: "Codex" | "Claude Code" | "Cowork"; status: "workflow_validated" | "connector_configured"; mcpConfig: "present" }>;
    versions: Array<{ resource: "sinc-mcp" | "mac-dark" | "mac-light"; version: string; status: "declared" | "parity_matched"; clients: string[] }>;
    projects: Array<{ projectId: string; policy: "configured"; map: "linked"; obsidian: "linked" }>;
    contract: { contractId: string; requirementCount: number; status: "prepared" };
  };
  generatedAt: string;
  source: "postgres_projection";
  authority: "informational_only";
  state: "empty" | "available";
  projectId: string | null;
  projects: string[];
  overview: {
    totalEvents: number;
    recommendations: number;
    blocked: number;
    integrationFailures: number;
    observedEvents: number;
    simulatedEvents: number;
    apiEquivalentCost: CostAggregate;
    observedBilledCost: CostAggregate;
    durationMs: { p50: number | null; p95: number | null };
  };
  recentRoutes: ProjectionEvent[];
  modelTree: Array<{ modelId: string; effort: string; state: ProjectionEvent["state"]; count: number }>;
  health: {
    sampleLimit: number;
    sampleLimited: boolean;
    totalStoredEvents: number;
    latestOccurredAt: string | null;
    latestReceivedAt: string | null;
    lagSeconds: number | null;
    gapStatus: "not_measured";
  };
}
