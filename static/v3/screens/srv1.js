/**
 * srv1 — Deep Dive Screen
 * Métricas detalhadas, containers, SSH, deploy history
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import { StatusBadge, ProgressBar, GaugeCircle, SparkLine, StepTracker, DrillCard } from "../components.js";

const html = htm.bind(h);

async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── Metrics gauges row ───────────────────────────────────────────────────────
function ServerMetrics({ health, loading }) {
  if (loading) return html`
    <div class="grid-4">
      ${[1,2,3,4].map(i => html`<div key=${i} class="skeleton" style=${{ height: "100px", borderRadius: "10px" }}/>`) }
    </div>
  `;

  // /api/hardware returns nested: cpu.percent, memory.percent, disk[0].percent, system.uptime_hours
  const cpu  = health.cpu?.percent ?? health.cpu_percent ?? 0;
  const mem  = health.memory?.percent ?? health.mem_percent ?? 0;
  const disk = health.disk?.[0]?.percent ?? health.disk_percent ?? 0;
  const uptimeH = health.system?.uptime_hours ?? (health.uptime_days != null ? (health.uptime_days * 24) : null);
  const uptime = (uptimeH != null && !isNaN(uptimeH))
    ? `${Math.floor(uptimeH / 24)}d ${Math.floor(uptimeH % 24)}h`
    : "—";
  const memUsedGb  = health.memory ? (health.memory.used  / 1073741824).toFixed(1) : (health.mem_used_gb?.toFixed(1)  ?? "—");
  const memTotalGb = health.memory ? (health.memory.total / 1073741824).toFixed(1) : (health.mem_total_gb?.toFixed(1) ?? "—");
  const diskUsedGb  = health.disk?.[0] ? (health.disk[0].used  / 1073741824).toFixed(0) : (health.disk_used_gb?.toFixed(0)  ?? "—");
  const diskTotalGb = health.disk?.[0] ? (health.disk[0].total / 1073741824).toFixed(0) : (health.disk_total_gb?.toFixed(0) ?? "—");

  return html`
    <div class="grid-4">
      <div class="card" style=${{ textAlign: "center" }}>
        <div class="card-title">CPU</div>
        <${GaugeCircle} value=${cpu} max=${100} label="CPU" size=${80}/>
      </div>
      <div class="card" style=${{ textAlign: "center" }}>
        <div class="card-title">Memória</div>
        <${GaugeCircle} value=${mem} max=${100} label="RAM" size=${80}/>
        <div style=${{ fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>
          ${memUsedGb}GB / ${memTotalGb}GB
        </div>
      </div>
      <div class="card" style=${{ textAlign: "center" }}>
        <div class="card-title">Disco</div>
        <${GaugeCircle} value=${disk} max=${100} label="DISK" size=${80}/>
        <div style=${{ fontSize: "11px", color: "var(--muted)", marginTop: "4px" }}>
          ${diskUsedGb}GB / ${diskTotalGb}GB
        </div>
      </div>
      <div class="card" style=${{ textAlign: "center" }}>
        <div class="card-title">Uptime</div>
        <div style=${{
          fontSize: "28px",
          fontWeight: 700,
          fontFamily: "var(--font-mono)",
          color: "var(--green)",
          lineHeight: 1,
          marginTop: "12px",
        }}>
          ${uptime}
        </div>
        <div style=${{ fontSize: "11px", color: "var(--muted)", marginTop: "8px" }}>
          IP: 62.72.63.18
        </div>
      </div>
    </div>
  `;
}

// ── Container detail table ───────────────────────────────────────────────────
function ContainerDetails({ containers, loading, onRestart }) {
  if (loading) return html`<div class="skeleton" style=${{ height: "250px", borderRadius: "8px" }}/>`;
  if (!containers?.length) return html`<div class="empty-state"><div>Nenhum container encontrado</div></div>`;

  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Nome</th>
            <th>Status</th>
            <th>Imagem</th>
            <th>CPU</th>
            <th>RAM</th>
            <th>Portas</th>
            <th>Ação</th>
          </tr>
        </thead>
        <tbody>
          ${containers.map((c, i) => {
            const name = c.name || c.Names?.[0]?.replace("/","") || "—";
            const status = c.state || c.status || c.State || "unknown";
            const isRunning = status === "running";
            return html`
              <tr key=${i}>
                <td>
                  <span style=${{ fontFamily: "var(--font-mono)", fontSize: "12px", color: isRunning ? "var(--cyan)" : "var(--muted)" }}>
                    ${name}
                  </span>
                </td>
                <td><${StatusBadge} status=${isRunning ? "running" : status === "exited" ? "stopped" : "error"}/></td>
                <td>
                  <span style=${{ fontSize: "11px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                    ${(c.image || c.Image || "—").split(":")[0].split("/").pop()}
                  </span>
                </td>
                <td>
                  <${ProgressBar} value=${parseFloat(c.cpu_percent || c.CPUPerc || 0)} max=${100} unit="%"/>
                </td>
                <td>
                  <span style=${{ fontSize: "12px", fontFamily: "var(--font-mono)" }}>
                    ${c.mem_usage || c.MemUsage || "—"}
                  </span>
                </td>
                <td>
                  <span style=${{ fontSize: "11px", color: "var(--muted)", fontFamily: "var(--font-mono)" }}>
                    ${c.ports || c.Ports || "—"}
                  </span>
                </td>
                <td>
                  ${isRunning && c.app_uuid && html`
                    <button
                      class="btn btn-red"
                      style=${{ fontSize: "11px", padding: "3px 8px" }}
                      onClick=${() => onRestart(c.app_uuid, name)}
                    >
                      ↺ Restart
                    </button>
                  `}
                </td>
              </tr>
            `;
          })}
        </tbody>
      </table>
    </div>
  `;
}

// ── Deploy history table ─────────────────────────────────────────────────────
function DeployHistory({ deploys, loading }) {
  if (loading) return html`<div class="skeleton" style=${{ height: "180px", borderRadius: "8px" }}/>`;
  if (!deploys?.length) return html`<div class="empty-state" style=${{ padding: "24px" }}><div>Nenhum deploy registrado</div></div>`;

  const statusColor = { success: "var(--green)", failed: "var(--red)", running: "var(--cyan)", pending: "var(--yellow)" };

  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Projeto</th>
            <th>Status</th>
            <th>Commit</th>
            <th>Duração</th>
            <th>Quando</th>
            <th>Trigger</th>
          </tr>
        </thead>
        <tbody>
          ${deploys.map((d, i) => html`
            <tr key=${i}>
              <td style=${{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--cyan)" }}>${d.project}</td>
              <td>
                <span style=${{ color: statusColor[d.status] || "var(--muted)", fontSize: "12px", fontWeight: 600 }}>
                  ${d.status === "success" ? "✓" : d.status === "failed" ? "✗" : "◉"} ${d.status}
                </span>
              </td>
              <td style=${{ fontFamily: "var(--font-mono)", fontSize: "11px", color: "var(--muted)" }}>
                ${d.commit_hash ? d.commit_hash.substring(0, 8) : "—"}
              </td>
              <td style=${{ fontSize: "12px" }}>${d.duration_sec != null ? `${d.duration_sec.toFixed(0)}s` : "—"}</td>
              <td style=${{ fontSize: "11px", color: "var(--muted)" }}>
                ${d.ts ? new Date(d.ts).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "—"}
              </td>
              <td style=${{ fontSize: "11px", color: "var(--muted)" }}>${d.triggered_by || "—"}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

// ── Main screen ──────────────────────────────────────────────────────────────
export default function Srv1Screen() {
  const [health,     setHealth]     = useState({});
  const [containers, setContainers] = useState([]);
  const [deploys,    setDeploys]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [restartMsg, setRestartMsg] = useState(null);

  const loadAll = useCallback(async () => {
    const [h, d, dep] = await Promise.allSettled([
      fetchJSON("/api/hardware"),
      fetchJSON("/api/server/docker/stats"),
      fetchJSON("/api/deploy/history?limit=20"),
    ]);
    if (h.status === "fulfilled")   setHealth(h.value || {});
    if (d.status === "fulfilled")   setContainers(d.value?.containers || d.value?.stats || []);
    if (dep.status === "fulfilled") setDeploys(dep.value?.deploys || []);
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); const t = setInterval(loadAll, 30_000); return () => clearInterval(t); }, []);

  const handleRestart = async (uuid, name) => {
    if (!confirm(`Reiniciar container ${name}?`)) return;
    setRestartMsg({ type: "info", text: `Reiniciando ${name}...` });
    try {
      const r = await fetch(`/api/containers/${uuid}/restart`, { method: "POST" });
      const body = await r.json();
      setRestartMsg({ type: r.ok ? "success" : "error", text: r.ok ? `✓ ${name} reiniciado` : `Erro: ${body.detail || "falha"}` });
    } catch (e) {
      setRestartMsg({ type: "error", text: `Erro: ${e.message}` });
    }
    setTimeout(() => setRestartMsg(null), 4000);
  };

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <!-- Header -->
      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h1 style=${{ fontSize: "20px", fontWeight: 700 }}>
          🖥 srv1 — Deep Dive
          <span style=${{ fontSize: "13px", color: "var(--muted)", fontWeight: 400, marginLeft: "8px" }}>
            62.72.63.18
          </span>
        </h1>
        <button class="btn btn-cyan" onClick=${loadAll}>↻ Atualizar</button>
      </div>

      ${restartMsg && html`
        <div style=${{
          padding: "10px 16px",
          borderRadius: "8px",
          background: restartMsg.type === "error" ? "rgba(255,51,102,0.1)" : "rgba(0,232,122,0.1)",
          border: `1px solid ${restartMsg.type === "error" ? "rgba(255,51,102,0.3)" : "rgba(0,232,122,0.3)"}`,
          color: restartMsg.type === "error" ? "var(--red)" : "var(--green)",
          fontSize: "13px",
        }}>
          ${restartMsg.text}
        </div>
      `}

      <!-- Metrics gauges -->
      <${ServerMetrics} health=${health} loading=${loading}/>

      <!-- Containers -->
      <div class="card">
        <div class="card-title">Containers Docker</div>
        <${ContainerDetails} containers=${containers} loading=${loading && containers.length === 0} onRestart=${handleRestart}/>
      </div>

      <!-- Deploy history -->
      <div class="card">
        <div class="card-title">Histórico de Deploys</div>
        <${DeployHistory} deploys=${deploys} loading=${loading && deploys.length === 0}/>
      </div>

    </div>
  `;
}
