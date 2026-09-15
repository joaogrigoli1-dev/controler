"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, Beaker, Bot, GitBranch, ShieldCheck } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import { RoteadorDashboardSchema, type RoteadorDashboard as Dashboard } from "@/lib/schemas";
import styles from "./RoteadorDashboard.module.css";

const UNKNOWN = "Não medido";
const STATES = { recommendation: "Recomendação", blocked: "Bloqueio", integration_failure: "Falha de integração" } as const;
const EXPERIMENT = { not_transported: "Não transportado", prepared: "Preparado", execution_incomplete: "Execução incompleta", partially_measured: "Medição parcial" } as const;

function n(value: number | null | undefined, suffix = "") { return value == null || !Number.isFinite(value) ? UNKNOWN : `${value.toLocaleString("pt-BR")}${suffix}`; }
function date(value: string | null | undefined) { return !value || !Number.isFinite(Date.parse(value)) ? UNKNOWN : new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }
function usd(value: string | null | undefined) { if (value == null || !/^\d+$/.test(value)) return UNKNOWN; const micros = BigInt(value); return `US$ ${(micros / 1_000_000n).toLocaleString("pt-BR")},${(micros % 1_000_000n).toString().padStart(6, "0")}`; }
function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warning" }) { return <span className={styles.tag} data-tone={tone}>{children}</span>; }
function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) { return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }

export function RoteadorDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false), inFlight = useRef(false);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true; setLoading(true); setError(null);
    try {
      const parsed = RoteadorDashboardSchema.parse(await apiFetch("/roteador/dashboard"));
      if (mounted.current) setData(parsed);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof ApiError && cause.status === 403 ? "Sua sessão não permite consultar o Roteador." : "Não foi possível consultar a projeção do Roteador.");
    } finally { inFlight.current = false; if (mounted.current) setLoading(false); }
  }, []);
  useEffect(() => {
    mounted.current = true; void refresh();
    const onKey = (event: KeyboardEvent) => { if (event.altKey && event.shiftKey && event.code === "KeyU") { event.preventDefault(); void refresh(); } };
    window.addEventListener("keydown", onKey); return () => { mounted.current = false; window.removeEventListener("keydown", onKey); };
  }, [refresh]);

  const m = data?.metrics;
  return <div className={styles.page} data-roteador-dashboard aria-busy={loading}>
    <header className={styles.hero}>
      <div><p className={styles.eyebrow}>Projeção informativa</p><h1>Roteador</h1><p>Histórico, estado corrente e evidências transportadas pelo Sinc.</p></div>
      <button className={styles.button} onClick={() => void refresh()} disabled={loading} aria-keyshortcuts="Alt+Shift+U" title="Atalho: Alt + Shift + U">{loading ? "Atualizando…" : "Atualizar painel"}</button>
    </header>

    <div className={styles.notice} role={error ? "alert" : "status"} aria-live="polite">
      <strong>{loading ? "Consultando projeção…" : error ? "Consulta não concluída" : data?.state === "empty" ? "Nenhum evento recebido" : "Leitura concluída"}</strong>
      <span>{error || (data?.health.sampleLimited ? "Os indicadores abaixo usam uma amostra parcial declarada." : "Esta tela não executa modelos, aceita tarefas nem promove políticas.")}</span>
    </div>

    <section className={styles.kpis} aria-label="Visão geral">
      {[["Eventos históricos", data?.overview.historyEvents], ["Entidades correntes", data?.overview.currentEntities], ["Recomendações na amostra", data?.overview.recommendations], ["Bloqueios na amostra", data?.overview.blocked], ["Falhas na amostra", data?.overview.integrationFailures]].map(([label, value]) => <article className={styles.kpi} key={String(label)}><span>{label}</span><strong>{n(value as number | undefined)}</strong></article>)}
    </section>

    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="route-metrics"><div className={styles.title}><Activity size={17} /><h2 id="route-metrics">Métricas por origem</h2></div>
        <table><thead><tr><th>Origem</th><th>Eventos</th><th>Duração p50 / p95</th><th>Equivalente API</th><th>Cobrança observada</th></tr></thead><tbody>
          {(["observed", "simulated"] as const).map(kind => { const group = m?.[kind]; return <tr key={kind}><td>{kind === "observed" ? "Observado" : "Simulado"}</td><td>{n(group?.eventCount)}</td><td>{n(group?.durationMs.p50, " ms")} / {n(group?.durationMs.p95, " ms")}</td><td>{usd(group?.apiEquivalentCost.totalMicros)}</td><td>{usd(group?.observedBilledCost.totalMicros)}</td></tr>; })}
        </tbody></table><p className={styles.help}>Totais só aparecem quando todos os valores do grupo foram medidos; zero explícito permanece zero.</p>
      </section>
      <section className={styles.card} aria-labelledby="route-health"><div className={styles.title}><ShieldCheck size={17} /><h2 id="route-health">Saúde da projeção</h2></div>
        <Facts rows={[["Eventos na amostra", n(data?.health.sampledEvents)], ["Total armazenado", n(data?.health.totalStoredEvents)], ["Amostra", data?.health.sampleLimited ? "Parcial" : data ? "Completa no limite consultado" : UNKNOWN], ["Lacunas detectadas", n(data?.health.detectedRevisionGaps)], ["Último evento", date(data?.health.latestOccurredAt)], ["Atraso", n(data?.health.lagSeconds, " s")]]} />
      </section>
    </div>

    <section className={styles.card} aria-labelledby="recent-routes"><div className={styles.titleRow}><div className={styles.title}><GitBranch size={17} /><h2 id="recent-routes">Rotas recentes</h2></div><span>Até 50 eventos · histórico e head separados</span></div>
      {!data?.recentRoutes.length ? <p className={styles.empty}>Nenhuma rota disponível nesta leitura.</p> : <div className={styles.tableWrap}><table><thead><tr><th>Entidade / revisão</th><th>Modelo / esforço</th><th>Estado</th><th>Origem</th><th>Regra transportada</th><th>Posição</th></tr></thead><tbody>{data.recentRoutes.map(item => <tr key={item.eventId}><td><code>{item.entityId.slice(0, 8)}</code><small>rev. {item.revision} · {date(item.occurredAt)}</small></td><td><code>{item.route?.model_id || UNKNOWN}</code><small>{item.route?.effort || UNKNOWN}</small></td><td><Tag tone={item.state === "recommendation" ? "neutral" : "warning"}>{STATES[item.state]}</Tag></td><td>{item.dataClass === "observed" ? "Observado" : "Simulado"}</td><td>{item.explanation.status === "transported" ? item.explanation.matchedRuleIds.map(rule => <code className={styles.rule} key={rule}>{rule}</code>) : "Não transportada"}</td><td><Tag tone={item.isCurrent ? "good" : "neutral"}>{item.isCurrent ? "Head atual" : "Histórico"}</Tag></td></tr>)}</tbody></table></div>}
    </section>

    <div className={styles.columns}>
      <section className={styles.card} aria-labelledby="model-tree"><div className={styles.title}><Bot size={17} /><h2 id="model-tree">Família → modelo → esforço</h2></div>
        {!data?.modelTree.length ? <p className={styles.empty}>Nenhum identificador de modelo recebido.</p> : <div className={styles.tree}>{data.modelTree.map(family => <div key={family.family}><h3>{family.family}</h3>{family.models.map(model => <div className={styles.model} key={`${model.modelId}:${model.effort}`}><code>{model.modelId}</code><span>{model.effort}</span><span>{model.observed} obs. · {model.simulated} sim.</span></div>)}</div>)}</div>}
      </section>
      <section className={styles.card} aria-labelledby="ab-pilot"><div className={styles.title}><Beaker size={17} /><h2 id="ab-pilot">Piloto A/B</h2><Tag>{data ? EXPERIMENT[data.experiment.status] : UNKNOWN}</Tag></div>
        <Facts rows={[["Pares planejados", n(data?.experiment.plannedPairs)], ["Pares executados", n(data?.experiment.executedPairs)], ["Pares avaliados", n(data?.experiment.evaluatedPairs)], ["Aprovação funcional", UNKNOWN], ["Falhas críticas", UNKNOWN], ["Economia pareada", UNKNOWN], ["Vencedor", UNKNOWN]]} />
        <p className={styles.help}>A ausência de pares completos mantém ganho, qualidade e vencedor como não medidos.</p>
      </section>
    </div>
    <footer className={styles.footer}>Fonte: projeção PostgreSQL do projeto roteador · Autoridade: somente informativa · Leitura: {date(data?.generatedAt)}</footer>
  </div>;
}
