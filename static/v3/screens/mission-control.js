/**
 * Mission Control — Home Screen
 * Visão geral em tempo real: containers, deploys, alertas, métricas
 */

import { h } from "https://esm.sh/preact@10";
import { useState, useEffect, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";
import {
  StatusBadge, ProgressBar, GaugeCircle, SparkLine, DrillCard, TerminalLog
} from "../components.js";

const html = htm.bind(h);

// ── API helpers ─────────────────────────────────────────────────────────────
async function fetchJSON(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── KPI Section ─────────────────────────────────────────────────────────────
function KpiRow({ stats, loading }) {
  if (loading) {
    return html`
      <div class="grid-4">
        ${[1,2,3,4].map(i => html`
          <div key=${i} class="skeleton" style=${{ height: "90px", borderRadius: "10px" }}/>
        `)}
      </div>
    `;
  }

  const items = [
    {
      title: "Containers",
      value: stats.running_containers ?? "—",
      subtitle: `${stats.total_containers ?? 0} total`,
      status: stats.running_containers > 0 ? "running" : "stopped",
      accent: "var(--cyan)",
    },
    {
      title: "CPU srv1",
      value: stats.cpu_percent != null ? `${stats.cpu_percent.toFixed(1)}%` : "—",
      subtitle: "últimos 5min",
      status: stats.cpu_percent > 85 ? "error" : stats.cpu_percent > 60 ? "warning" : "healthy",
    },
    {
      title: "RAM srv1",
      value: stats.mem_percent != null ? `${stats.mem_percent.toFixed(1)}%` : "—",
      subtitle: stats.mem_used_gb != null ? `${stats.mem_used_gb.toFixed(1)}GB / ${stats.mem_total_gb?.toFixed(1)}GB` : "",
      status: stats.mem_percent > 85 ? "error" : stats.mem_percent > 70 ? "warning" : "healthy",
    },
    {
      title: "Alertas",
      value: stats.active_alerts ?? "—",
      subtitle: `${stats.critical_alerts ?? 0} críticos`,
      status: stats.critical_alerts > 0 ? "error" : stats.active_alerts > 0 ? "warning" : "healthy",
      accent: stats.critical_alerts > 0 ? "var(--red)" : stats.active_alerts > 0 ? "var(--yellow)" : "var(--green)",
    },
  ];

  return html`
    <div class="grid-4">
      ${items.map((item, i) => html`
        <${DrillCard} key=${i} ...${item}/>
      `)}
    </div>
  `;
}

// ── Container list ───────────────────────────────────────────────────────────
function ContainerTable({ containers, loading }) {
  if (loading) return html`<div class="skeleton" style=${{ height: "200px", borderRadius: "8px" }}/>`;

  if (!containers || containers.length === 0) {
    return html`
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <div>Nenhum container encontrado</div>
      </div>
    `;
  }

  return html`
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Container</th>
            <th>Status</th>
            <th>CPU</th>
            <th>RAM</th>
            <th>Uptime</th>
          </tr>
        </thead>
        <tbody>
          ${containers.map((c, i) => html`
            <tr key=${i}>
              <td>
                <span style=${{ fontFamily: "var(--font-mono)", fontSize: "12px", color: "var(--cyan)" }}>
                  ${c.name || c.Names?.[0]?.replace("/","") || "—"}
                </span>
              </td>
              <td>
                <${StatusBadge} status=${
                  c.status === "running" || c.State === "running" ? "running" :
                  c.status === "exited"  || c.State === "exited"  ? "stopped" :
                  "unknown"
                }/>
              </td>
              <td>
                <${ProgressBar}
                  value=${parseFloat(c.cpu_percent || c.CPUPerc || 0)}
                  max=${100}
                  unit="%"
                />
              </td>
              <td>
                <span style=${{ fontSize: "12px", fontFamily: "var(--font-mono)" }}>
                  ${c.mem_usage || c.MemUsage || "—"}
                </span>
              </td>
              <td>
                <span style=${{ fontSize: "12px", color: "var(--muted)" }}>
                  ${c.uptime || c.Status || "—"}
                </span>
              </td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

// ── Recent Timeline ──────────────────────────────────────────────────────────
function RecentTimeline({ events, loading }) {
  if (loading) return html`<div class="skeleton" style=${{ height: "180px", borderRadius: "8px" }}/>`;

  if (!events || events.length === 0) {
    return html`
      <div class="empty-state" style=${{ padding: "24px" }}>
        <div>Nenhum evento recente</div>
      </div>
    `;
  }

  const severityColor = { critical: "var(--red)", warning: "var(--yellow)", info: "var(--cyan)", success: "var(--green)" };

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "8px" }}>
      ${events.slice(0, 8).map((ev, i) => html`
        <div key=${i} style=${{
          display: "flex",
          alignItems: "flex-start",
          gap: "10px",
          padding: "8px 10px",
          borderRadius: "6px",
          background: "var(--surface2)",
          borderLeft: `3px solid ${severityColor[ev.severity] || "var(--border2)"}`,
        }}>
          <div style=${{ flex: 1, minWidth: 0 }}>
            <div style=${{ fontSize: "12px", fontWeight: 600, color: "var(--text)", truncate: true }}>
              ${ev.title}
            </div>
            ${ev.detail && html`
              <div style=${{ fontSize: "11px", color: "var(--muted)", marginTop: "2px" }}>
                ${ev.detail}
              </div>
            `}
          </div>
          <div style=${{ fontSize: "11px", color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
            ${ev.ts ? new Date(ev.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }) : "—"}
          </div>
        </div>
      `)}
    </div>
  `;
}

// ── CPU/RAM sparklines history ───────────────────────────────────────────────
function MetricsRow({ history, loading }) {
  if (loading) return html`
    <div class="grid-2">
      ${[1,2].map(i => html`<div key=${i} class="skeleton" style=${{ height: "80px", borderRadius: "8px" }}/>` )}
    </div>
  `;

  const cpuData  = history.map(h => h.cpu_percent || 0);
  const memData  = history.map(h => h.mem_percent || 0);

  return html`
    <div class="grid-2">
      <div class="card">
        <div class="card-title">CPU — 24h</div>
        <div style=${{ display: "flex", alignItems: "center", gap: "16px" }}>
          <${GaugeCircle} value=${cpuData[cpuData.length-1] ?? 0} max=${100} label="CPU" size=${72}/>
          <div style=${{ flex: 1 }}>
            <${SparkLine} data=${cpuData} color="var(--cyan)" width=${160} height=${40}/>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="card-title">RAM — 24h</div>
        <div style=${{ display: "flex", alignItems: "center", gap: "16px" }}>
          <${GaugeCircle} value=${memData[memData.length-1] ?? 0} max=${100} label="RAM" size=${72}/>
          <div style=${{ flex: 1 }}>
            <${SparkLine} data=${memData} color="var(--purple)" width=${160} height=${40}/>
          </div>
        </div>
      </div>
    </div>
  `;
}

// ── Main Screen ──────────────────────────────────────────────────────────────
export default function MissionControl() {
  const [stats,      setStats]      = useState({});
  const [containers, setContainers] = useState([]);
  const [timeline,   setTimeline]   = useState([]);
  const [history,    setHistory]    = useState([]);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      // Fetch in parallel
      const [hwRes, dockerRes, timelineRes, historyRes, alertsRes] = await Promise.allSettled([
        fetchJSON("/api/hardware"),
        fetchJSON("/api/server/docker/stats"),
        fetchJSON("/api/timeline?limit=10"),
        fetchJSON("/api/metrics/history?hours=24"),
        fetchJSON("/api/alerts"),
      ]);

      const hw       = hwRes.status === "fulfilled"       ? hwRes.value       : {};
      const docker   = dockerRes.status === "fulfilled"   ? dockerRes.value   : {};
      const tl       = timelineRes.status === "fulfilled" ? timelineRes.value : {};
      const hist     = historyRes.status === "fulfilled"  ? historyRes.value  : {};
      const alerts   = alertsRes.status === "fulfilled"   ? alertsRes.value   : {};

      const containerList = docker.containers || docker.stats || [];
      const memUsedGb  = hw.memory ? hw.memory.used  / 1073741824 : null;
      const memTotalGb = hw.memory ? hw.memory.total / 1073741824 : null;

      setStats({
        running_containers: containerList.filter(c => c.status === "running" || c.State === "running").length,
        total_containers:   containerList.length,
        cpu_percent:        hw.cpu?.percent ?? null,
        mem_percent:        hw.memory?.percent ?? null,
        mem_used_gb:        memUsedGb,
        mem_total_gb:       memTotalGb,
        active_alerts:      alerts.active_count ?? 0,
        critical_alerts:    (alerts.alerts || []).filter(a => a.severity === "critical" && !a.sent).length,
      });

      setContainers(containerList.slice(0, 10));
      setTimeline(tl.events || []);
      setHistory(hist.snapshots || []);
      setLastRefresh(new Date());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
    const interval = setInterval(loadAll, 30_000); // auto-refresh 30s
    return () => clearInterval(interval);
  }, [loadAll]);

  return html`
    <div style=${{ display: "flex", flexDirection: "column", gap: "20px" }}>

      <!-- Header row -->
      <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style=${{ fontSize: "20px", fontWeight: 700, color: "var(--text)", marginBottom: "4px" }}>
            Mission Control
          </h1>
          <div style=${{ fontSize: "12px", color: "var(--muted)" }}>
            ${lastRefresh
              ? `Atualizado às ${lastRefresh.toLocaleTimeString("pt-BR")} · auto-refresh 30s`
              : "Carregando..."
            }
          </div>
        </div>
        <button class="btn btn-cyan" onClick=${loadAll}>
          <span>↻</span> Atualizar
        </button>
      </div>

      <!-- Error banner -->
      ${error && html`
        <div style=${{
          background: "rgba(255,51,102,0.1)",
          border: "1px solid rgba(255,51,102,0.3)",
          borderRadius: "8px",
          padding: "12px 16px",
          color: "var(--red)",
          fontSize: "13px",
        }}>
          ⚠️ Erro ao carregar dados: ${error}
        </div>
      `}

      <!-- KPIs -->
      <${KpiRow} stats=${stats} loading=${loading}/>

      <!-- Metrics sparklines -->
      <${MetricsRow} history=${history} loading=${loading && history.length === 0}/>

      <!-- Containers + Timeline side by side -->
      <div class="grid-2" style=${{ gridTemplateColumns: "1.5fr 1fr" }}>
        <div class="card">
          <div class="card-title">Containers — srv1</div>
          <${ContainerTable} containers=${containers} loading=${loading && containers.length === 0}/>
        </div>

        <div class="card">
          <div class="card-title">Timeline Recente</div>
          <${RecentTimeline} events=${timeline} loading=${loading && timeline.length === 0}/>
        </div>
      </div>

    </div>
  `;
}
