/**
 * Timeline — Histórico de eventos do sistema
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { StatusBadge } from "../components.js";

const html = htm.bind(h);

async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const SEVERITY_COLOR = {
  critical: "var(--red)",
  warning:  "var(--yellow)",
  info:     "var(--cyan)",
  success:  "var(--green)",
};

const SEVERITY_ICON = {
  critical: "🔴",
  warning:  "🟡",
  info:     "🔵",
  success:  "🟢",
};

const EVENT_TYPE_ICON = {
  deploy:     "🚀",
  alert:      "🔔",
  restart:    "↺",
  health:     "💗",
  scheduler:  "⏱",
  manual:     "👤",
  scan:       "🔍",
};

export default function TimelineScreen() {
  const [events,   setEvents]   = useState([]);
  const [total,    setTotal]    = useState(0);
  const [loading,  setLoading]  = useState(true);
  const [filter,   setFilter]   = useState({ severity: "", project: "", event_type: "" });
  const [page,     setPage]     = useState(0);
  const PAGE_SIZE = 25;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        ...(filter.severity   && { severity: filter.severity }),
        ...(filter.project    && { project: filter.project }),
        ...(filter.event_type && { event_type: filter.event_type }),
      });
      const data = await fetchJSON(`/api/timeline?${params}`);
      setEvents(data.events || []);
      setTotal(data.total || 0);
    } catch {}
    finally { setLoading(false); }
  }, [page, filter]);

  useEffect(() => { load(); }, [load]);

  const handleFilter = (key, val) => {
    setFilter(f => ({ ...f, [key]: val }));
    setPage(0);
  };

  // Group events by date
  const grouped = events.reduce((acc, ev) => {
    const day = ev.ts ? ev.ts.substring(0, 10) : "—";
    if (!acc[day]) acc[day] = [];
    acc[day].push(ev);
    return acc;
  }, {});

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <!-- Header -->
      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "12px" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>⏱ Timeline</h1>
        <div style=${{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          ${["", "critical", "warning", "info", "success"].map(sev => html`
            <button
              key=${sev || "all"}
              class=${"btn" + (filter.severity === sev ? " btn-cyan" : "")}
              onClick=${() => handleFilter("severity", sev)}
              style=${{ padding: "4px 10px", fontSize: "11px" }}
            >
              ${sev ? (SEVERITY_ICON[sev] + " " + sev) : "Todos"}
            </button>
          `)}
          <button class="btn btn-cyan" onClick=${load} style=${{ padding: "4px 10px", fontSize: "11px" }}>↻</button>
        </div>
      </div>

      <!-- Total count -->
      <div style=${{ fontSize: "12px", color: "var(--muted)" }}>
        ${total} eventos · mostrando ${events.length}
      </div>

      <!-- Timeline feed -->
      ${loading
        ? html`
            <div style=${{ display: "flex", flexDirection: "column", gap: "10px" }}>
              ${[1,2,3,4,5].map(i => html`<div key=${i} class="skeleton" style=${{ height: "56px", borderRadius: "8px" }}/>`)}
            </div>
          `
        : events.length === 0
          ? html`
              <div class="empty-state">
                <div class="empty-icon">⏱</div>
                <div>Nenhum evento encontrado</div>
              </div>
            `
          : html`
              <div style=${{ display: "flex", flexDirection: "column", gap: "0" }}>
                ${Object.entries(grouped).map(([day, dayEvents]) => html`
                  <div key=${day}>
                    <!-- Day separator -->
                    <div style=${{
                      fontSize: "11px",
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      padding: "16px 0 8px",
                      borderBottom: "1px solid var(--border)",
                      marginBottom: "8px",
                    }}>
                      ${day}
                    </div>

                    <!-- Events of this day -->
                    <div style=${{ display: "flex", flexDirection: "column", gap: "4px", marginBottom: "8px" }}>
                      ${dayEvents.map((ev, i) => html`
                        <div key=${i} style=${{
                          display: "flex",
                          alignItems: "flex-start",
                          gap: "12px",
                          padding: "10px 12px",
                          borderRadius: "8px",
                          background: "var(--surface)",
                          border: "1px solid var(--border)",
                          borderLeft: `3px solid ${SEVERITY_COLOR[ev.severity] || "var(--border2)"}`,
                          transition: "border-color 0.15s",
                        }}>
                          <div style=${{
                            fontSize: "16px",
                            width: "24px",
                            flexShrink: 0,
                            marginTop: "1px",
                          }}>
                            ${EVENT_TYPE_ICON[ev.event_type] || "◦"}
                          </div>
                          <div style=${{ flex: 1, minWidth: 0 }}>
                            <div style=${{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                              <span style=${{ fontWeight: 600, fontSize: "13px" }}>${ev.title}</span>
                              ${ev.project && html`
                                <span style=${{
                                  fontSize: "10px",
                                  padding: "1px 6px",
                                  borderRadius: "8px",
                                  background: "rgba(0,212,255,0.1)",
                                  color: "var(--cyan)",
                                  border: "1px solid rgba(0,212,255,0.2)",
                                }}>
                                  ${ev.project}
                                </span>
                              `}
                            </div>
                            ${ev.detail && html`
                              <div style=${{ fontSize: "12px", color: "var(--muted)", marginTop: "2px" }}>
                                ${ev.detail}
                              </div>
                            `}
                          </div>
                          <div style=${{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: "4px", flexShrink: 0 }}>
                            <span style=${{ fontSize: "11px", color: "var(--muted)" }}>
                              ${ev.ts ? new Date(ev.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"}
                            </span>
                            ${ev.actor && ev.actor !== "system" && html`
                              <span style=${{ fontSize: "10px", color: "var(--muted)" }}>${ev.actor}</span>
                            `}
                          </div>
                        </div>
                      `)}
                    </div>
                  </div>
                `)}
              </div>

              <!-- Pagination -->
              <div style=${{ display: "flex", justifyContent: "center", gap: "8px", paddingTop: "8px" }}>
                <button class="btn" disabled=${page === 0} onClick=${() => setPage(p => p - 1)}>← Anterior</button>
                <span style=${{ padding: "6px 12px", fontSize: "12px", color: "var(--muted)" }}>
                  Pág. ${page + 1} / ${Math.max(1, Math.ceil(total / PAGE_SIZE))}
                </span>
                <button class="btn" disabled=${(page + 1) * PAGE_SIZE >= total} onClick=${() => setPage(p => p + 1)}>Próxima →</button>
              </div>
            `
      }
    </div>
  `;
}
