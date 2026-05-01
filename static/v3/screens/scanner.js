/**
 * Resource Scanner — Detecta recursos ociosos, problemas de infra
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";

const html = htm.bind(h);

async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const CATEGORY_ICON = {
  containers:    "📦",
  images:        "🖼",
  git_branches:  "🌿",
  ssm_params:    "🔐",
  cron_jobs:     "⏱",
};

const SEVERITY_COLOR = {
  high:   "var(--red)",
  medium: "var(--yellow)",
  low:    "var(--cyan)",
  ok:     "var(--green)",
};

export default function ScannerScreen() {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [scanned, setScanned] = useState(null);
  const [error,   setError]   = useState(null);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJSON("/api/scanner/run");
      setResults(data);
      setScanned(new Date());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load last cached result on mount
  useEffect(() => {
    fetchJSON("/api/scanner/last").then(d => {
      if (d?.results) { setResults(d.results); setScanned(d.ts ? new Date(d.ts) : null); }
    }).catch(() => {});
  }, []);

  const totalIssues = results
    ? Object.values(results).reduce((acc, cat) => acc + (cat.issues?.length || 0), 0)
    : 0;

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>🔍 Resource Scanner</h1>
          ${scanned && html`
            <div style=${{ fontSize: "12px", color: "var(--muted)", marginTop: "4px" }}>
              Último scan: ${scanned.toLocaleString("pt-BR")}
            </div>
          `}
        </div>
        <button
          class=${"btn" + (loading ? "" : " btn-cyan")}
          onClick=${runScan}
          disabled=${loading}
        >
          ${loading
            ? html`<span class="spinner"/> Escaneando...`
            : "▶ Executar Scan"
          }
        </button>
      </div>

      ${error && html`
        <div style=${{
          background: "rgba(255,51,102,0.08)",
          border: "1px solid rgba(255,51,102,0.2)",
          borderRadius: "8px",
          padding: "12px 16px",
          color: "var(--red)",
          fontSize: "13px",
        }}>
          ⚠️ ${error}
          ${error.includes("404") && html`
            <div style=${{ marginTop: "8px", color: "var(--muted)", fontSize: "12px" }}>
              O endpoint <code style=${{ fontFamily: "var(--font-mono)" }}>/api/scanner/run</code> será implementado na FASE 5.
            </div>
          `}
        </div>
      `}

      ${!results && !loading && !error && html`
        <div class="card" style=${{ textAlign: "center", padding: "48px" }}>
          <div style=${{ fontSize: "48px", marginBottom: "16px" }}>🔍</div>
          <div style=${{ fontWeight: 600, fontSize: "16px", marginBottom: "8px" }}>Scanner Pronto</div>
          <div style=${{ color: "var(--muted)", fontSize: "13px", marginBottom: "20px" }}>
            Detecta containers parados, imagens orphan, branches velhas,<br/>
            parâmetros SSM não usados e cron jobs com falha.
          </div>
          <button class="btn btn-cyan" onClick=${runScan}>▶ Executar Scan Agora</button>
        </div>
      `}

      ${loading && html`
        <div class="card" style=${{ textAlign: "center", padding: "48px" }}>
          <div class="spinner" style=${{ width: "32px", height: "32px", borderWidth: "3px", margin: "0 auto 16px" }}/>
          <div style=${{ color: "var(--muted)" }}>Escaneando recursos...</div>
        </div>
      `}

      ${results && !loading && html`
        <!-- Summary -->
        <div class="card" style=${{
          background: totalIssues === 0 ? "rgba(0,232,122,0.05)" : "rgba(255,204,0,0.05)",
          border: `1px solid ${totalIssues === 0 ? "rgba(0,232,122,0.2)" : "rgba(255,204,0,0.2)"}`,
        }}>
          <div style=${{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span style=${{ fontSize: "24px" }}>${totalIssues === 0 ? "✅" : "⚠️"}</span>
            <div>
              <div style=${{ fontWeight: 700, fontSize: "15px" }}>
                ${totalIssues === 0 ? "Tudo OK — nenhum problema encontrado" : `${totalIssues} problema(s) encontrado(s)`}
              </div>
              <div style=${{ fontSize: "12px", color: "var(--muted)" }}>
                ${Object.keys(results).length} categorias verificadas
              </div>
            </div>
          </div>
        </div>

        <!-- Category results -->
        <div class="grid-2">
          ${Object.entries(results).map(([cat, data]) => html`
            <div key=${cat} class="card">
              <div class="card-title" style=${{ display: "flex", alignItems: "center", gap: "6px" }}>
                ${CATEGORY_ICON[cat] || "◦"}
                ${cat.replace(/_/g, " ")}
                ${data.issues?.length > 0 && html`
                  <span style=${{
                    marginLeft: "auto",
                    background: "rgba(255,204,0,0.15)",
                    color: "var(--yellow)",
                    border: "1px solid rgba(255,204,0,0.3)",
                    borderRadius: "10px",
                    padding: "1px 7px",
                    fontSize: "10px",
                    fontWeight: 700,
                  }}>
                    ${data.issues.length}
                  </span>
                `}
              </div>

              ${!data.issues || data.issues.length === 0
                ? html`
                    <div style=${{ display: "flex", alignItems: "center", gap: "8px", color: "var(--green)", fontSize: "13px" }}>
                      ✓ Nenhum problema
                    </div>
                  `
                : html`
                    <div style=${{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      ${data.issues.map((issue, i) => html`
                        <div key=${i} style=${{
                          padding: "8px 10px",
                          borderRadius: "6px",
                          background: "var(--surface2)",
                          borderLeft: `3px solid ${SEVERITY_COLOR[issue.severity] || "var(--border2)"}`,
                          fontSize: "12px",
                        }}>
                          <div style=${{ fontWeight: 600, color: SEVERITY_COLOR[issue.severity] || "var(--text)" }}>
                            ${issue.title || issue.name}
                          </div>
                          ${issue.detail && html`
                            <div style=${{ color: "var(--muted)", marginTop: "2px" }}>${issue.detail}</div>
                          `}
                          ${issue.action && html`
                            <div style=${{
                              marginTop: "6px",
                              fontFamily: "var(--font-mono)",
                              fontSize: "11px",
                              color: "var(--cyan)",
                              background: "var(--bg)",
                              padding: "4px 6px",
                              borderRadius: "4px",
                            }}>
                              ${issue.action}
                            </div>
                          `}
                        </div>
                      `)}
                    </div>
                  `
              }
            </div>
          `)}
        </div>
      `}
    </div>
  `;
}
