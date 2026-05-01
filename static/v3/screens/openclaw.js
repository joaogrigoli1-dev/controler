/**
 * OpenClaw Agents — Status e gerenciamento dos agentes IA
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { StatusBadge, TerminalLog } from "../components.js";

const html = htm.bind(h);

async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

export default function OpenClawScreen() {
  const [agents,    setAgents]    = useState([]);
  const [jobs,      setJobs]      = useState([]);
  const [logs,      setLogs]      = useState([]);
  const [loading,   setLoading]   = useState(true);
  const [selected,  setSelected]  = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [agentsRes, jobsRes] = await Promise.allSettled([
      fetchJSON("/api/openclaw/agents"),
      fetchJSON("/api/scheduler/jobs"),
    ]);
    if (agentsRes.status === "fulfilled") setAgents(agentsRes.value?.agents || []);
    if (jobsRes.status === "fulfilled")   setJobs(jobsRes.value?.jobs || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const loadLogs = async (agentId) => {
    setSelected(agentId);
    try {
      const data = await fetchJSON(`/api/openclaw/agents/${agentId}/logs?limit=50`);
      setLogs(data.logs || []);
    } catch {
      setLogs(["[erro ao carregar logs]"]);
    }
  };

  const statusMap = { running: "running", idle: "healthy", error: "error", paused: "warning", stopped: "stopped" };

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>🤖 OpenClaw Agents</h1>
        <button class="btn btn-cyan" onClick=${load}>↻ Atualizar</button>
      </div>

      <!-- APScheduler jobs -->
      <div class="card">
        <div class="card-title">⏱ Jobs Agendados (APScheduler)</div>
        ${loading
          ? html`<div class="skeleton" style=${{ height: "100px", borderRadius: "8px" }}/>`
          : jobs.length === 0
            ? html`<div class="empty-state" style=${{ padding: "24px" }}><div>Nenhum job agendado</div></div>`
            : html`
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr><th>Job ID</th><th>Próx. Execução</th><th>Trigger</th><th>Status</th></tr>
                    </thead>
                    <tbody>
                      ${jobs.map((j, i) => html`
                        <tr key=${i}>
                          <td style=${{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--cyan)" }}>${j.id}</td>
                          <td style=${{ fontSize: "12px" }}>
                            ${j.next_run_time
                              ? new Date(j.next_run_time).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })
                              : html`<span style=${{ color: "var(--muted)" }}>—</span>`
                            }
                          </td>
                          <td style=${{ fontSize: "11px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                            ${j.trigger || "—"}
                          </td>
                          <td>
                            <${StatusBadge} status=${j.next_run_time ? "running" : "stopped"}/>
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              `
        }
      </div>

      <!-- Agents list + log viewer -->
      <div class="grid-2">
        <div class="card">
          <div class="card-title">Agentes</div>
          ${loading
            ? html`<div class="skeleton" style=${{ height: "200px", borderRadius: "8px" }}/>`
            : agents.length === 0
              ? html`
                  <div class="empty-state" style=${{ padding: "32px" }}>
                    <div class="empty-icon">🤖</div>
                    <div>Nenhum agente ativo</div>
                    <div style=${{ fontSize: "12px", color: "var(--muted)" }}>
                      OpenClaw agents são iniciados pelo APScheduler
                    </div>
                  </div>
                `
              : html`
                  <div style=${{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    ${agents.map((a, i) => html`
                      <div
                        key=${i}
                        onClick=${() => loadLogs(a.id)}
                        style=${{
                          padding: "12px",
                          borderRadius: "8px",
                          background: selected === a.id ? "rgba(0,212,255,0.08)" : "var(--surface2)",
                          border: `1px solid ${selected === a.id ? "rgba(0,212,255,0.3)" : "var(--border)"}`,
                          cursor: "pointer",
                          transition: "all 0.15s",
                        }}
                      >
                        <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <div>
                            <div style=${{ fontWeight: 600, marginBottom: "4px" }}>${a.name || a.id}</div>
                            <div style=${{ fontSize: "11px", color: "var(--muted)" }}>
                              ${a.last_run
                                ? `Último run: ${new Date(a.last_run).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}`
                                : "Aguardando execução"
                              }
                            </div>
                          </div>
                          <${StatusBadge} status=${statusMap[a.status] || "unknown"}/>
                        </div>
                        ${a.last_result && html`
                          <div style=${{
                            marginTop: "8px",
                            fontSize: "11px",
                            fontFamily: "var(--font-mono)",
                            color: "var(--muted)",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}>
                            ${a.last_result}
                          </div>
                        `}
                      </div>
                    `)}
                  </div>
                `
          }
        </div>

        <div class="card">
          <div class="card-title">
            ${selected ? `Logs — ${selected}` : "Logs — selecione um agente"}
          </div>
          <${TerminalLog} lines=${logs} height=${300}/>
        </div>
      </div>
    </div>
  `;
}
