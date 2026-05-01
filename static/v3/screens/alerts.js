/**
 * Alert Center — Gestão e teste de alertas
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

const SEV_COLOR = {
  critical: "var(--red)",
  warning:  "var(--yellow)",
  info:     "var(--cyan)",
};

export default function AlertsScreen() {
  const [alerts,     setAlerts]     = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [testForm,   setTestForm]   = useState({ severity: "warning", title: "Teste", message: "Mensagem de teste" });
  const [testResult, setTestResult] = useState(null);
  const [sending,    setSending]    = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchJSON("/api/alerts?limit=50");
      setAlerts(data.alerts || []);
    } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const sendTest = async () => {
    setSending(true);
    setTestResult(null);
    try {
      const r = await fetch("/api/alerts/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testForm),
      });
      const body = await r.json();
      setTestResult({ ok: r.ok, data: body });
    } catch (e) {
      setTestResult({ ok: false, data: { error: e.message } });
    } finally {
      setSending(false);
    }
  };

  const criticalCount  = alerts.filter(a => a.severity === "critical").length;
  const warningCount   = alerts.filter(a => a.severity === "warning").length;
  const sentCount      = alerts.filter(a => a.sent).length;

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>🔔 Alert Center</h1>
        <button class="btn btn-cyan" onClick=${load}>↻ Atualizar</button>
      </div>

      <!-- Stats row -->
      <div class="grid-3">
        <div class="card" style=${{ textAlign: "center" }}>
          <div class="card-title">Críticos</div>
          <div style=${{ fontSize: "32px", fontWeight: 700, color: "var(--red)", fontFamily: "var(--font-mono)" }}>
            ${criticalCount}
          </div>
        </div>
        <div class="card" style=${{ textAlign: "center" }}>
          <div class="card-title">Warnings</div>
          <div style=${{ fontSize: "32px", fontWeight: 700, color: "var(--yellow)", fontFamily: "var(--font-mono)" }}>
            ${warningCount}
          </div>
        </div>
        <div class="card" style=${{ textAlign: "center" }}>
          <div class="card-title">Enviados</div>
          <div style=${{ fontSize: "32px", fontWeight: 700, color: "var(--green)", fontFamily: "var(--font-mono)" }}>
            ${sentCount}
          </div>
        </div>
      </div>

      <!-- Test panel -->
      <div class="card">
        <div class="card-title">🧪 Testar Alerta</div>
        <div style=${{ display: "grid", gridTemplateColumns: "1fr 2fr 2fr auto", gap: "10px", alignItems: "end" }}>
          <div>
            <label style=${{ fontSize: "11px", color: "var(--muted)", display: "block", marginBottom: "4px" }}>Severidade</label>
            <select
              value=${testForm.severity}
              onChange=${e => setTestForm(f => ({ ...f, severity: e.target.value }))}
              style=${{
                width: "100%",
                background: "var(--surface2)",
                border: "1px solid var(--border2)",
                borderRadius: "6px",
                color: "var(--text)",
                padding: "6px 8px",
                fontSize: "13px",
              }}
            >
              <option value="critical">critical</option>
              <option value="warning">warning</option>
              <option value="info">info</option>
            </select>
          </div>
          <div>
            <label style=${{ fontSize: "11px", color: "var(--muted)", display: "block", marginBottom: "4px" }}>Título</label>
            <input
              type="text"
              value=${testForm.title}
              onInput=${e => setTestForm(f => ({ ...f, title: e.target.value }))}
              style=${{
                width: "100%",
                background: "var(--surface2)",
                border: "1px solid var(--border2)",
                borderRadius: "6px",
                color: "var(--text)",
                padding: "6px 10px",
                fontSize: "13px",
              }}
            />
          </div>
          <div>
            <label style=${{ fontSize: "11px", color: "var(--muted)", display: "block", marginBottom: "4px" }}>Mensagem</label>
            <input
              type="text"
              value=${testForm.message}
              onInput=${e => setTestForm(f => ({ ...f, message: e.target.value }))}
              style=${{
                width: "100%",
                background: "var(--surface2)",
                border: "1px solid var(--border2)",
                borderRadius: "6px",
                color: "var(--text)",
                padding: "6px 10px",
                fontSize: "13px",
              }}
            />
          </div>
          <button
            class="btn btn-cyan"
            onClick=${sendTest}
            disabled=${sending}
            style=${{ height: "34px" }}
          >
            ${sending ? html`<span class="spinner"/>` : "Enviar"}
          </button>
        </div>

        ${testResult && html`
          <div style=${{
            marginTop: "12px",
            padding: "10px 14px",
            borderRadius: "6px",
            background: testResult.ok ? "rgba(0,232,122,0.08)" : "rgba(255,51,102,0.08)",
            border: `1px solid ${testResult.ok ? "rgba(0,232,122,0.2)" : "rgba(255,51,102,0.2)"}`,
            fontSize: "12px",
            fontFamily: "var(--font-mono)",
            color: testResult.ok ? "var(--green)" : "var(--red)",
          }}>
            ${JSON.stringify(testResult.data, null, 2)}
          </div>
        `}
      </div>

      <!-- Alert log table -->
      <div class="card">
        <div class="card-title">Log de Alertas (últimos 50)</div>
        ${loading
          ? html`<div class="skeleton" style=${{ height: "200px", borderRadius: "8px" }}/>`
          : alerts.length === 0
            ? html`<div class="empty-state" style=${{ padding: "32px" }}><div>Nenhum alerta registrado</div></div>`
            : html`
                <div class="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Severidade</th>
                        <th>Título</th>
                        <th>Canal</th>
                        <th>Enviado</th>
                        <th>Quando</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${alerts.map((a, i) => html`
                        <tr key=${i}>
                          <td>
                            <span style=${{ color: SEV_COLOR[a.severity] || "var(--text)", fontWeight: 600, fontSize: "12px" }}>
                              ${a.severity?.toUpperCase()}
                            </span>
                          </td>
                          <td style=${{ maxWidth: "300px" }}>
                            <div style=${{ fontWeight: 500, fontSize: "13px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              ${a.title}
                            </div>
                            ${a.body && html`<div style=${{ fontSize: "11px", color: "var(--muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>${a.body}</div>`}
                          </td>
                          <td style=${{ fontSize: "11px", fontFamily: "var(--font-mono)", color: "var(--muted)" }}>${a.channel}</td>
                          <td>
                            <span style=${{ color: a.sent ? "var(--green)" : "var(--red)", fontSize: "13px" }}>
                              ${a.sent ? "✓" : "✗"}
                            </span>
                          </td>
                          <td style=${{ fontSize: "11px", color: "var(--muted)" }}>
                            ${a.ts ? new Date(a.ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}
                          </td>
                        </tr>
                      `)}
                    </tbody>
                  </table>
                </div>
              `
        }
      </div>
    </div>
  `;
}
