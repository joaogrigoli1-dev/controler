"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Boxes, GitBranch, Layers, Radio, BookOpen, Monitor } from "lucide-react";
import { ApiError, apiFetch } from "@/lib/api";
import type { Dashboard, ProjectionEvent } from "./types";
import styles from "./SincDashboard.module.css";

const PROJECTS = ["myclinicsoft", "t4net-so", "senhas-fisiomt", "roteador"];
const CLIENTS = ["Codex", "Claude Code", "Cowork"];
const VERSIONS = [["sinc-mcp", "Sinc MCP", "2.1.0"], ["mac-dark", "mac-dark", "2.6.3"], ["mac-light", "mac-light", "1.1.0"]];
const STATES: Record<ProjectionEvent["state"], string> = {
  recommendation: "Recomendação", blocked: "Bloqueado", integration_failure: "Falha de integração",
};
const UNKNOWN = "Não medido";

function date(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return UNKNOWN;
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Cuiaba", dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}
function number(value: number | null | undefined, suffix = "") {
  return value == null || !Number.isFinite(value) ? UNKNOWN : `${value.toLocaleString("pt-BR", { maximumFractionDigits: 2 })}${suffix}`;
}
function usd(micros: string | null | undefined) {
  if (micros == null || !/^\d+$/.test(micros)) return UNKNOWN;
  const value = BigInt(micros);
  return `US$ ${(value / 1_000_000n).toLocaleString("pt-BR")},${(value % 1_000_000n).toString().padStart(6, "0")}`;
}
function Status({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "good" | "warning" }) {
  return <span className={styles.status} data-tone={tone}>{children}</span>;
}
function Facts({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return <dl className={styles.facts}>{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export function SincDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      const result = await apiFetch<Dashboard>("/sinc/dashboard");
      if (!result || result.source !== "postgres_projection" || result.authority !== "informational_only" || !Array.isArray(result.recentRoutes) || !Array.isArray(result.projects) || !result.overview || !result.health) {
        throw new Error("Unexpected dashboard response");
      }
      if (mounted.current) setData(result);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof ApiError && cause.status === 403
        ? "Sua sessão não tem acesso ao painel Sinc. Verifique as permissões com o administrador."
        : "Não foi possível consultar o Sinc. Use Atualizar painel para tentar novamente.");
    } finally {
      inFlight.current = false;
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const onKey = (event: KeyboardEvent) => {
      if (event.altKey && event.shiftKey && event.code === "KeyU") { event.preventDefault(); void refresh(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { mounted.current = false; window.removeEventListener("keydown", onKey); };
  }, [refresh]);

  const overview = data?.overview;
  const integration = data?.integration?.evidenceKind === "last_measured" ? data.integration : undefined;
  const connection = loading ? "Consultando projeção" : error ? "Consulta indisponível" : data ? "Projeção consultada" : UNKNOWN;

  return <div className={styles.panel} data-sinc-dashboard aria-busy={loading}>
    <div className={styles.header}>
      <div className={styles.headerText}>
        <h1>Sinc</h1>
        <p className={styles.muted}>Projetos, recomendações e evidências de conexão.</p>
      </div>
      <button className={styles.button} onClick={() => void refresh()} disabled={loading} title="Atualizar painel (Alt + Shift + U)" aria-keyshortcuts="Alt+Shift+U">Atualizar painel</button>
    </div>

    <div className={`${styles.card} ${styles.notice}`} role={error ? "alert" : "status"} aria-live="polite">
      <strong>{loading ? "Consultando o painel…" : error ? "Consulta não concluída" : data?.state === "empty" ? "Nenhuma projeção recebida" : "Painel atualizado"}</strong>
      <p className={styles.muted}>{error || (loading ? "Aguardando a resposta do servidor." : data?.state === "empty" ? "O servidor respondeu, mas ainda não há eventos. Atualize o painel depois do próximo envio do coletor." : "As recomendações abaixo são informativas; execução e aceite não são medidos por esta fonte.")}</p>
      {integration && <p>Integrações · última medição: {date(integration.measuredAt)} (Cuiabá). Esta fotografia não comprova conexão em tempo real.</p>}
      {error && data && <p>Última leitura mantida, sem atualização confirmada: {date(data.generatedAt)}.</p>}
    </div>

    <div className={styles.grid}>
      <section className={styles.card} aria-labelledby="sinc-connection">
        <div className={styles.cardHeader}><div className={styles.cardTitle}><Radio size={16} aria-hidden /><h2 id="sinc-connection">Conexão</h2></div><Status tone={error ? "warning" : data && !loading ? "good" : "neutral"}>{connection}</Status></div>
        <Facts rows={[["Último recebimento", date(data?.health.latestReceivedAt)], ["Último evento", date(data?.health.latestOccurredAt)], ["Idade do último evento", number(data?.health.lagSeconds, " s")], ["Lacunas de entrega", UNKNOWN], ["Conexão direta com o MCP", UNKNOWN]]} />
      </section>
      <section className={styles.card} aria-labelledby="sinc-overview">
        <div className={styles.cardHeader}><div className={styles.cardTitle}><Layers size={16} aria-hidden /><h2 id="sinc-overview">Projeções recebidas</h2></div><Status>{!data ? UNKNOWN : data.health.sampleLimited ? "Janela parcial" : "Janela disponível"}</Status></div>
        <Facts rows={[["Eventos na janela", number(overview?.totalEvents)], ["Recomendações", number(overview?.recommendations)], ["Bloqueios / falhas de integração", `${number(overview?.blocked)} / ${number(overview?.integrationFailures)}`], ["Observados / simulados", `${number(overview?.observedEvents)} / ${number(overview?.simulatedEvents)}`], ["Duração p50 / p95", `${number(overview?.durationMs.p50, " ms")} / ${number(overview?.durationMs.p95, " ms")}`]]} />
      </section>
    </div>

    <section aria-labelledby="sinc-projects">
      <div className={styles.cardHeader}><div className={styles.cardTitle}><Boxes size={16} aria-hidden /><h2 id="sinc-projects">Projetos</h2></div><span className={styles.muted}>Presença de projeções não comprova sincronia.</span></div>
      <div className={styles.projects}>{PROJECTS.map(project => { const measured = integration?.projects.find(item => item.projectId === project); return <article className={`${styles.card} ${styles.project}`} key={project}>
        <h3>{project}</h3>
        <Status>{data?.projects.includes(project) ? "Projeção registrada" : UNKNOWN}</Status>
        <Facts rows={[["Política", measured?.policy === "configured" ? "Configurada" : UNKNOWN], ["DEV / GIT / PROD", UNKNOWN], ["Mapa", measured?.map === "linked" ? "Vinculado" : UNKNOWN], ["Obsidian", measured?.obsidian === "linked" ? "Vinculado" : UNKNOWN]]} />
      </article>; })}</div>
    </section>

    <div className={styles.grid}>
      <section className={styles.card} aria-labelledby="sinc-clients">
        <div className={styles.cardHeader}><div className={styles.cardTitle}><Monitor size={16} aria-hidden /><h2 id="sinc-clients">Clientes</h2></div></div>
        <table className={styles.table}><caption>Última medição: {date(integration?.measuredAt)}. Sessões ativas não medidas.</caption><thead><tr><th scope="col">Cliente</th><th scope="col">Última evidência</th><th scope="col">Configuração MCP</th></tr></thead><tbody>{CLIENTS.map(client => { const measured = integration?.clients.find(item => item.client === client); return <tr key={client}><td>{client}</td><td>{measured?.status === "workflow_validated" ? "Fluxo validado" : measured?.status === "connector_configured" ? "Conector configurado" : UNKNOWN}</td><td>{measured?.mcpConfig === "present" ? "Presente" : UNKNOWN}</td></tr>; })}</tbody></table>
      </section>
      <section className={styles.card} aria-labelledby="sinc-versions">
        <div className={styles.cardHeader}><h2 id="sinc-versions">Versões</h2></div>
        <table className={styles.table}><caption>Última medição: {date(integration?.measuredAt)}. Versões em execução não medidas.</caption><thead><tr><th scope="col">Componente</th><th scope="col">Referência / medição</th><th scope="col">Evidência</th></tr></thead><tbody>{VERSIONS.map(([resource, name, version]) => { const measured = integration?.versions.find(item => item.resource === resource); return <tr key={name}><td>{name}</td><td><span className={styles.mono}>{version}</span><div className={styles.muted}>Medição: {measured?.version || UNKNOWN}</div></td><td>{measured?.status === "parity_matched" ? "Paridade conferida" : measured?.status === "declared" ? "Versão declarada" : UNKNOWN}{!!measured?.clients.length && <div className={styles.muted}>{measured.clients.join(", ")}</div>}</td></tr>; })}</tbody></table>
      </section>
    </div>

    <section className={styles.card} aria-labelledby="sinc-routes">
      <div className={styles.cardHeader}><div className={styles.cardTitle}><GitBranch size={16} aria-hidden /><h2 id="sinc-routes">Rotas recentes</h2></div><span className={styles.muted}>Até 50 eventos · horário de Cuiabá (UTC−4)</span></div>
      {!data?.recentRoutes.length ? <p className={styles.empty}>Nenhuma rota disponível nesta leitura. Use Atualizar painel para consultar novamente.</p> : <table className={styles.table}><thead><tr><th scope="col">Projeto / horário</th><th scope="col">Modelo / esforço</th><th scope="col">Estado</th><th scope="col">Origem</th><th scope="col">Duração</th></tr></thead><tbody>{data.recentRoutes.map(event => <tr key={event.event_id}>
        <td>{event.project_id}<div className={styles.muted}>{date(event.occurred_at)}</div></td>
        <td><span className={styles.mono}>{event.route?.model_id || UNKNOWN}</span><div className={styles.muted}>{event.route?.effort || UNKNOWN}</div></td>
        <td><Status tone={event.state === "recommendation" ? "neutral" : "warning"}>{STATES[event.state] || UNKNOWN}</Status></td>
        <td>{event.source.data_class === "observed" ? "Observado" : "Simulado"}<div className={styles.mono}>{event.source.kind}</div></td>
        <td>{number(event.metrics.duration_ms, " ms")}</td>
      </tr>)}</tbody></table>}
    </section>

    <div className={styles.grid}>
      <section className={styles.card} aria-labelledby="sinc-costs">
        <div className={styles.cardHeader}><h2 id="sinc-costs">Custos na janela</h2></div>
        <Facts rows={[["Equivalente de API", usd(overview?.apiEquivalentCost.knownCount ? overview.apiEquivalentCost.totalMicros : null)], ["Cobrança observada", usd(overview?.observedBilledCost.knownCount ? overview.observedBilledCost.totalMicros : null)], ["Custos de API desconhecidos", number(overview?.apiEquivalentCost.unknownCount)], ["Cobranças desconhecidas", number(overview?.observedBilledCost.unknownCount)]]} />
        <p className={`${styles.empty}`}>Equivalência de API não representa cobrança. Ausência de valor não significa custo zero.</p>
      </section>
      <section className={styles.card} aria-labelledby="sinc-knowledge">
        <div className={styles.cardHeader}><div className={styles.cardTitle}><BookOpen size={16} aria-hidden /><h2 id="sinc-knowledge">Contratos e conhecimento</h2></div></div>
        <Facts rows={[["Contrato", integration?.contract ? <span className={styles.mono}>{integration.contract.contractId}</span> : UNKNOWN], ["Estado do contrato", integration?.contract.status === "prepared" ? "Preparado" : UNKNOWN], ["Requisitos do contrato", number(integration?.contract.requirementCount)], ["Execução e aceite", UNKNOWN], ["Sincronização Obsidian", UNKNOWN]]} />
        <p className={styles.empty}>Mapa e Obsidian vinculados não comprovam sincronização. Contrato preparado não significa aceite.</p>
      </section>
    </div>
    <p className={styles.footer}>Fonte: {data ? "projeção persistida no Controler" : "aguardando leitura"} · Leitura: {date(data?.generatedAt)} · Janela: {number(data?.health.sampleLimit)} eventos mais recentes · Total armazenado: {number(data?.health.totalStoredEvents)}{data?.health.sampleLimited ? " · Indicadores limitados à janela parcial." : ""}</p>
  </div>;
}
