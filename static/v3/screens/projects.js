/**
 * Projects — Overview de todos os projetos monitorados
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { StatusBadge, StepTracker, DrillCard } from "../components.js";

const html = htm.bind(h);

async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Fallback static project list (when API unavailable)
const STATIC_PROJECTS = [
  { name: "myclinicsoft",  label: "MyClinicSoft",     lang: "Node.js",  status: "unknown", url: "myclinicsoft.com.br" },
  { name: "controler",     label: "Controler",         lang: "Python",   status: "unknown", url: "controler.net.br" },
  { name: "libertakidz",   label: "LibertaKidz",       lang: "Node.js",  status: "unknown", url: "" },
  { name: "whatsapp-buffer", label: "WhatsApp Buffer", lang: "Node.js",  status: "unknown", url: "dev.myclinicsoft.com.br" },
];

export default function ProjectsScreen() {
  const [projects, setProjects] = useState([]);
  const [deploys,  setDeploys]  = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [selected, setSelected] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [projRes, depRes] = await Promise.allSettled([
      fetchJSON("/api/projects"),
      fetchJSON("/api/deploy/history?limit=30"),
    ]);

    if (projRes.status === "fulfilled") {
      setProjects(projRes.value?.projects || projRes.value || []);
    } else {
      setProjects(STATIC_PROJECTS);
    }

    if (depRes.status === "fulfilled") {
      setDeploys(depRes.value?.deploys || []);
    }

    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const projectDeploys = (name) => deploys.filter(d => d.project === name);

  const lastDeployStatus = (name) => {
    const recent = projectDeploys(name)[0];
    if (!recent) return "unknown";
    return recent.status === "success" ? "healthy" :
           recent.status === "failed"  ? "error" : "warning";
  };

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>📦 Projects</h1>
        <button class="btn btn-cyan" onClick=${load}>↻ Atualizar</button>
      </div>

      <!-- Project cards -->
      ${loading
        ? html`
            <div class="grid-2">
              ${[1,2,3,4].map(i => html`<div key=${i} class="skeleton" style=${{ height: "130px", borderRadius: "10px" }}/>`)}
            </div>
          `
        : html`
            <div class="grid-2">
              ${projects.map((p, i) => {
                const status = lastDeployStatus(p.name);
                return html`
                  <div
                    key=${i}
                    class="card"
                    onClick=${() => setSelected(selected === p.name ? null : p.name)}
                    style=${{
                      cursor: "pointer",
                      border: `1px solid ${selected === p.name ? "rgba(0,212,255,0.4)" : "var(--border)"}`,
                      transition: "all 0.2s",
                    }}
                  >
                    <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
                      <div>
                        <div style=${{ fontWeight: 700, fontSize: "15px", marginBottom: "4px" }}>
                          ${p.label || p.name}
                        </div>
                        <div style=${{ fontSize: "11px", color: "var(--muted)" }}>
                          ${p.lang || "—"}
                          ${p.url && html` · <a href=${"https://" + p.url} target="_blank" style=${{ color: "var(--cyan)", textDecoration: "none" }}>${p.url}</a>`}
                        </div>
                      </div>
                      <${StatusBadge} status=${p.status !== "unknown" ? p.status : status}/>
                    </div>

                    <!-- Recent deploy info -->
                    ${(() => {
                      const recent = projectDeploys(p.name)[0];
                      return recent
                        ? html`
                            <div style=${{
                              background: "var(--surface2)",
                              borderRadius: "6px",
                              padding: "8px 10px",
                              fontSize: "11px",
                              color: "var(--muted)",
                              display: "flex",
                              justifyContent: "space-between",
                            }}>
                              <span>Último deploy: <span style=${{ color: recent.status === "success" ? "var(--green)" : "var(--red)" }}>${recent.status}</span></span>
                              <span>${recent.ts ? new Date(recent.ts).toLocaleDateString("pt-BR") : "—"}</span>
                            </div>
                          `
                        : html`
                            <div style=${{
                              background: "var(--surface2)",
                              borderRadius: "6px",
                              padding: "8px 10px",
                              fontSize: "11px",
                              color: "var(--muted)",
                            }}>
                              Nenhum deploy registrado
                            </div>
                          `;
                    })()}
                  </div>
                `;
              })}
            </div>

            <!-- Selected project deploy history -->
            ${selected && html`
              <div class="card">
                <div class="card-title">Deploy History — ${selected}</div>
                ${projectDeploys(selected).length === 0
                  ? html`<div class="empty-state" style=${{ padding: "24px" }}><div>Nenhum deploy para este projeto</div></div>`
                  : html`
                      <div class="table-wrap">
                        <table>
                          <thead>
                            <tr><th>Status</th><th>Commit</th><th>Duração</th><th>Trigger</th><th>Quando</th></tr>
                          </thead>
                          <tbody>
                            ${projectDeploys(selected).map((d, i) => html`
                              <tr key=${i}>
                                <td>
                                  <span style=${{
                                    color: d.status === "success" ? "var(--green)" : d.status === "failed" ? "var(--red)" : "var(--yellow)",
                                    fontWeight: 600, fontSize: "12px"
                                  }}>
                                    ${d.status === "success" ? "✓" : "✗"} ${d.status}
                                  </span>
                                </td>
                                <td style=${{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--muted)" }}>
                                  ${d.commit_hash ? d.commit_hash.substring(0, 8) : "—"}
                                </td>
                                <td style=${{ fontSize: "12px" }}>${d.duration_sec != null ? `${Math.round(d.duration_sec)}s` : "—"}</td>
                                <td style=${{ fontSize: "11px", color: "var(--muted)" }}>${d.triggered_by || "—"}</td>
                                <td style=${{ fontSize: "11px", color: "var(--muted)" }}>
                                  ${d.ts ? new Date(d.ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}
                                </td>
                              </tr>
                            `)}
                          </tbody>
                        </table>
                      </div>
                    `
                }
              </div>
            `}
          `
      }
    </div>
  `;
}
