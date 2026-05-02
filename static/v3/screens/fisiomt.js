/**
 * FisioMT Panel — Status do VPS FisioMT + contas HestiaCP
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { StatusBadge, ProgressBar, DrillCard } from "../components.js";

const html = htm.bind(h);

async function fetchJSON(path, timeout = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(path, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

export default function FisioMTScreen() {
  const [stats,    setStats]    = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [domains,  setDomains]  = useState({});
  const [expanded, setExpanded] = useState(null);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [statsRes, accsRes] = await Promise.allSettled([
      fetchJSON("/api/vps-fisiomt/stats"),
      fetchJSON("/api/vps-fisiomt/hestia/accounts"),
    ]);
    if (statsRes.status === "fulfilled") setStats(statsRes.value);
    else setError(statsRes.reason?.message || "Erro ao carregar stats");
    if (accsRes.status === "fulfilled")   setAccounts(accsRes.value?.accounts || accsRes.value || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 60_000); return () => clearInterval(t); }, [load]);

  const loadDomains = async (username) => {
    if (expanded === username) { setExpanded(null); return; }
    setExpanded(username);
    if (domains[username]) return;
    try {
      const data = await fetchJSON(`/api/vps-fisiomt/hestia/domains/${username}`);
      setDomains(d => ({ ...d, [username]: data.domains || data || [] }));
    } catch {
      setDomains(d => ({ ...d, [username]: [] }));
    }
  };

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <!-- Header -->
      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>🏥 FisioMT Panel</h1>
        <button class="btn btn-cyan" onClick=${load}>↻ Atualizar</button>
      </div>

      ${error && html`
        <div style=${{
          background: "rgba(255,51,102,0.08)",
          border: "1px solid rgba(255,51,102,0.2)",
          borderRadius: "8px", padding: "12px 16px", color: "var(--red)", fontSize: "13px",
        }}>
          ⚠️ ${error}
        </div>
      `}

      <!-- Server stats cards -->
      ${loading && !stats
        ? html`
            <div class="grid-4">
              ${[1,2,3,4].map(i => html`<div key=${i} class="skeleton" style=${{ height: "90px", borderRadius: "10px" }}/>`)}
            </div>
          `
        : stats && html`
            <div class="grid-4">
              <${DrillCard}
                title="CPU"
                value=${stats.cpu_percent != null ? `${stats.cpu_percent.toFixed(1)}%` : "—"}
                subtitle="FisioMT VPS"
                status=${stats.cpu_percent > 85 ? "error" : stats.cpu_percent > 60 ? "warning" : "healthy"}
              />
              <${DrillCard}
                title="RAM"
                value=${stats.mem_percent != null ? `${stats.mem_percent.toFixed(1)}%` : "—"}
                subtitle=${stats.mem_used_gb != null ? `${stats.mem_used_gb.toFixed(1)}GB / ${stats.mem_total_gb?.toFixed(1)}GB` : ""}
                status=${stats.mem_percent > 85 ? "error" : stats.mem_percent > 70 ? "warning" : "healthy"}
              />
              <${DrillCard}
                title="Disco"
                value=${stats.disk_percent != null ? `${stats.disk_percent.toFixed(1)}%` : "—"}
                subtitle=${stats.disk_used_gb != null ? `${stats.disk_used_gb.toFixed(0)}GB / ${stats.disk_total_gb?.toFixed(0)}GB` : ""}
                status=${stats.disk_percent > 85 ? "error" : "healthy"}
              />
              <${DrillCard}
                title="HestiaCP"
                value=${stats.hestia_version || "Online"}
                subtitle=${stats.hostname || "fisiomt"}
                status="running"
                accent="var(--purple)"
              />
            </div>
          `
      }

      <!-- Accounts table -->
      <div class="card">
        <div class="card-title">Contas HestiaCP</div>

        ${loading && accounts.length === 0
          ? html`<div class="skeleton" style=${{ height: "200px", borderRadius: "8px" }}/>`
          : accounts.length === 0
            ? html`
                <div class="empty-state">
                  <div class="empty-icon">👤</div>
                  <div>Nenhuma conta encontrada</div>
                </div>
              `
            : html`
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Usuário</th>
                        <th>Plano</th>
                        <th>Status</th>
                        <th>Web</th>
                        <th>Mail</th>
                        <th>DB</th>
                        <th>Disco</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      ${accounts.map((acc, i) => {
                        const isExpanded = expanded === (acc.USER || acc.user);
                        const username = acc.USER || acc.user || "—";
                        const isActive = (acc.SUSPENDED || acc.suspended) !== "yes";
                        return html`
                          <tr
                            key=${i}
                            style=${{ cursor: "pointer", background: isExpanded ? "var(--surface2)" : "transparent" }}
                            onClick=${() => loadDomains(username)}
                          >
                            <td>
                              <span style=${{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--cyan)" }}>
                                ${username}
                              </span>
                            </td>
                            <td style=${{ fontSize: "12px", color: "var(--muted)" }}>
                              ${acc.PACKAGE || acc.package || "—"}
                            </td>
                            <td>
                              <${StatusBadge} status=${isActive ? "running" : "stopped"} label=${isActive ? "ativo" : "suspenso"}/>
                            </td>
                            <td style=${{ fontSize: "12px" }}>${acc.WEB_DOMAINS ?? acc.web_domains ?? "—"}</td>
                            <td style=${{ fontSize: "12px" }}>${acc.MAIL_DOMAINS ?? acc.mail_domains ?? "—"}</td>
                            <td style=${{ fontSize: "12px" }}>${acc.DATABASES ?? acc.databases ?? "—"}</td>
                            <td style=${{ minWidth: "100px" }}>
                              <${ProgressBar}
                                value=${parseFloat(acc.DISK_USAGE ?? acc.disk_usage ?? 0)}
                                max=${parseFloat(acc.DISK_QUOTA ?? acc.disk_quota ?? 100)}
                                unit="MB"
                              />
                            </td>
                            <td style=${{ fontSize: "11px", color: "var(--cyan)" }}>
                              ${isExpanded ? "▲" : "▼"}
                            </td>
                          </tr>

                          ${isExpanded && html`
                            <tr key=${"dom-" + i}>
                              <td colspan="8" style=${{ padding: "0", background: "var(--bg)" }}>
                                <div style=${{ padding: "12px 20px", borderBottom: "1px solid var(--border)" }}>
                                  ${!domains[username]
                                    ? html`<div style=${{ color: "var(--muted)", fontSize: "12px" }}>Carregando domínios...</div>`
                                    : domains[username].length === 0
                                      ? html`<div style=${{ color: "var(--muted)", fontSize: "12px" }}>Nenhum domínio</div>`
                                      : html`
                                          <div style=${{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
                                            ${(Array.isArray(domains[username]) ? domains[username] : Object.keys(domains[username])).map((dom, j) => html`
                                              <span key=${j} style=${{
                                                fontSize: "11px",
                                                fontFamily: "var(--font-mono)",
                                                padding: "2px 8px",
                                                borderRadius: "6px",
                                                background: "rgba(0,212,255,0.08)",
                                                border: "1px solid rgba(0,212,255,0.15)",
                                                color: "var(--cyan)",
                                              }}>
                                                ${dom.DOMAIN || dom.domain || dom}
                                              </span>
                                            `)}
                                          </div>
                                        `
                                  }
                                </div>
                              </td>
                            </tr>
                          `}
                        `;
                      })}
                    </tbody>
                  </table>
                </div>
              `
        }
      </div>
    </div>
  `;
}
