import type { NocSource } from "@/lib/noc";

/**
 * DataBadge — proveniência do dado (regra "nunca fingir verde"):
 *  MOCK  = endpoint FASE 3 pendente, dado simulado rotulado.
 *  STALE = temos dado, mas o último refresh falhou.
 * LIVE não é exibido (ausência de badge = dado real fresco).
 */
export function DataBadge({ source, stale }: { source?: NocSource; stale?: boolean }) {
  if (stale) {
    return (
      <span className="badge badge-muted" title="Último refresh falhou — exibindo dado anterior">
        STALE
      </span>
    );
  }
  if (source === "mock") {
    return (
      <span className="badge badge-yellow" title="Coletor da FASE 3 pendente — dado simulado">
        MOCK
      </span>
    );
  }
  return null;
}
