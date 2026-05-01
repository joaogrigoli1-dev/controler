/**
 * Vault SSM — Visualização de parâmetros AWS SSM
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

export default function VaultScreen() {
  const [params,  setParams]  = useState([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState(null);
  const [reveal,  setReveal]  = useState({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJSON("/api/vault/params");
      setParams(data.params || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const grouped = params.reduce((acc, p) => {
    const parts = (p.name || "").split("/");
    const prefix = parts.slice(0, 3).join("/") || "/";
    if (!acc[prefix]) acc[prefix] = [];
    acc[prefix].push(p);
    return acc;
  }, {});

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>🔐 Vault SSM</h1>
        <button class="btn btn-cyan" onClick=${load}>↻ Atualizar</button>
      </div>

      <!-- Notice -->
      <div style=${{
        background: "rgba(255,204,0,0.08)",
        border: "1px solid rgba(255,204,0,0.2)",
        borderRadius: "8px",
        padding: "12px 16px",
        fontSize: "12px",
        color: "var(--yellow)",
      }}>
        🔒 Valores sensíveis são mascarados. Clique em "Revelar" para ver (ação é logada).
      </div>

      ${error && html`
        <div style=${{
          background: "rgba(255,51,102,0.08)",
          border: "1px solid rgba(255,51,102,0.2)",
          borderRadius: "8px",
          padding: "12px 16px",
          fontSize: "13px",
          color: "var(--red)",
        }}>
          ⚠️ ${error}
          ${error.includes("404") && html`
            <div style=${{ marginTop: "8px", color: "var(--muted)" }}>
              O endpoint <code style=${{ fontFamily: "var(--font-mono)" }}>/api/vault/params</code> ainda não está implementado.
            </div>
          `}
        </div>
      `}

      ${loading
        ? html`
            <div style=${{ display: "flex", flexDirection: "column", gap: "12px" }}>
              ${[1,2,3].map(i => html`<div key=${i} class="skeleton" style=${{ height: "100px", borderRadius: "10px" }}/>`)}
            </div>
          `
        : params.length === 0 && !error
          ? html`
              <div class="empty-state">
                <div class="empty-icon">🔐</div>
                <div>Nenhum parâmetro SSM encontrado</div>
                <div style=${{ fontSize: "12px", color: "var(--muted)" }}>
                  Parâmetros devem estar no path <code style=${{ fontFamily: "var(--font-mono)" }}>/controler/*</code>
                </div>
              </div>
            `
          : html`
              ${Object.entries(grouped).map(([prefix, items]) => html`
                <div key=${prefix} class="card">
                  <div class="card-title" style=${{ fontFamily: "var(--font-mono)" }}>${prefix}</div>
                  <div class="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Parâmetro</th>
                          <th>Tipo</th>
                          <th>Valor</th>
                          <th>Modificado</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        ${items.map((p, i) => {
                          const isRevealed = reveal[p.name];
                          const paramKey = p.name?.split("/").pop();
                          return html`
                            <tr key=${i}>
                              <td>
                                <span style=${{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--cyan)" }}>
                                  ${paramKey}
                                </span>
                              </td>
                              <td>
                                <span style=${{
                                  fontSize: "10px",
                                  padding: "2px 6px",
                                  borderRadius: "4px",
                                  background: p.type === "SecureString" ? "rgba(153,69,255,0.15)" : "rgba(100,116,139,0.15)",
                                  color: p.type === "SecureString" ? "var(--purple)" : "var(--muted)",
                                }}>
                                  ${p.type || "String"}
                                </span>
                              </td>
                              <td>
                                <span style=${{
                                  fontFamily: "var(--font-mono)",
                                  fontSize: "12px",
                                  color: isRevealed ? "var(--green)" : "var(--muted)",
                                  letterSpacing: isRevealed ? "normal" : "0.2em",
                                }}>
                                  ${isRevealed ? (p.value || "—") : "••••••••"}
                                </span>
                              </td>
                              <td style=${{ fontSize: "11px", color: "var(--muted)" }}>
                                ${p.last_modified ? new Date(p.last_modified).toLocaleDateString("pt-BR") : "—"}
                              </td>
                              <td>
                                <button
                                  class=${"btn" + (isRevealed ? " btn-red" : "")}
                                  style=${{ fontSize: "11px", padding: "3px 8px" }}
                                  onClick=${() => setReveal(r => ({ ...r, [p.name]: !r[p.name] }))}
                                >
                                  ${isRevealed ? "Ocultar" : "Revelar"}
                                </button>
                              </td>
                            </tr>
                          `;
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              `)}
            `
      }
    </div>
  `;
}
