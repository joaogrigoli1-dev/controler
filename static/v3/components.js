/**
 * Controler v3 — Component Library
 * Preact + HTM via ESM CDN (no build step)
 *
 * Import: import { StatusBadge, ProgressBar, ... } from './components.js'
 */

import { h, Fragment } from "https://esm.sh/preact@10";
import { useState, useEffect, useRef, useCallback } from "https://esm.sh/preact@10/hooks";
import htm from "https://esm.sh/htm@3";

const html = htm.bind(h);

// ─────────────────────────────────────────────────────────────────────────────
// StatusBadge
// status: 'running' | 'stopped' | 'error' | 'warning' | 'unknown' | 'healthy'
// ─────────────────────────────────────────────────────────────────────────────
export function StatusBadge({ status = "unknown", label }) {
  const map = {
    running:  { color: "var(--green)",  bg: "rgba(0,232,122,0.1)",  dot: true },
    healthy:  { color: "var(--green)",  bg: "rgba(0,232,122,0.1)",  dot: true },
    stopped:  { color: "var(--muted)",  bg: "rgba(100,116,139,0.1)", dot: false },
    error:    { color: "var(--red)",    bg: "rgba(255,51,102,0.1)",  dot: false },
    warning:  { color: "var(--yellow)", bg: "rgba(255,204,0,0.1)",   dot: false },
    degraded: { color: "var(--yellow)", bg: "rgba(255,204,0,0.1)",   dot: false },
    unknown:  { color: "var(--muted)",  bg: "rgba(100,116,139,0.1)", dot: false },
  };

  const cfg = map[status] || map.unknown;
  const displayLabel = label || status;

  return html`
    <span style=${{
      display: "inline-flex",
      alignItems: "center",
      gap: "6px",
      padding: "3px 10px",
      borderRadius: "12px",
      background: cfg.bg,
      border: `1px solid ${cfg.color}30`,
      color: cfg.color,
      fontSize: "11px",
      fontWeight: 600,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
    }}>
      ${cfg.dot && html`
        <span style=${{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          background: cfg.color,
          boxShadow: `0 0 6px ${cfg.color}`,
          animation: "pulse 2s ease-in-out infinite",
        }}/>
      `}
      ${displayLabel}
    </span>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// ProgressBar
// value: number, max: number (default 100), unit: string
// Thresholds: ≤60% green, ≤85% yellow, >85% red
// ─────────────────────────────────────────────────────────────────────────────
export function ProgressBar({ value = 0, max = 100, unit = "%", label }) {
  const pct = Math.min(100, Math.round((value / max) * 100));
  const color =
    pct > 85 ? "var(--red)" :
    pct > 60 ? "var(--yellow)" :
               "var(--cyan)";

  return html`
    <div style=${{ width: "100%" }}>
      ${label && html`
        <div style=${{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: "4px",
          fontSize: "12px",
          color: "var(--muted)",
        }}>
          <span>${label}</span>
          <span style=${{ color }}>${value}${unit}</span>
        </div>
      `}
      <div style=${{
        width: "100%",
        height: "6px",
        background: "var(--border)",
        borderRadius: "3px",
        overflow: "hidden",
      }}>
        <div style=${{
          width: `${pct}%`,
          height: "100%",
          background: color,
          borderRadius: "3px",
          boxShadow: `0 0 8px ${color}80`,
          transition: "width 0.4s ease",
        }}/>
      </div>
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// GaugeCircle
// SVG circular gauge — HUD style
// ─────────────────────────────────────────────────────────────────────────────
export function GaugeCircle({ value = 0, max = 100, label = "", size = 80 }) {
  const pct = Math.min(100, (value / max) * 100);
  const r = (size - 10) / 2;
  const circ = 2 * Math.PI * r;
  const fill = (pct / 100) * circ;
  const color =
    pct > 85 ? "var(--red)" :
    pct > 60 ? "var(--yellow)" :
               "var(--cyan)";

  return html`
    <div style=${{
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      gap: "4px",
    }}>
      <svg width=${size} height=${size} viewBox="0 0 ${size} ${size}">
        <!-- Track -->
        <circle
          cx=${size/2} cy=${size/2} r=${r}
          fill="none"
          stroke="var(--border)"
          strokeWidth="4"
        />
        <!-- Fill -->
        <circle
          cx=${size/2} cy=${size/2} r=${r}
          fill="none"
          stroke=${color}
          strokeWidth="4"
          strokeDasharray="${fill} ${circ}"
          strokeLinecap="round"
          transform="rotate(-90 ${size/2} ${size/2})"
          style=${{ filter: `drop-shadow(0 0 4px ${color})`, transition: "stroke-dasharray 0.5s ease" }}
        />
        <!-- Text -->
        <text
          x=${size/2} y=${size/2 + 1}
          textAnchor="middle"
          dominantBaseline="middle"
          fill=${color}
          fontSize=${size * 0.2}
          fontWeight="700"
          fontFamily="'JetBrains Mono', monospace"
        >
          ${Math.round(pct)}%
        </text>
      </svg>
      ${label && html`
        <span style=${{ fontSize: "11px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          ${label}
        </span>
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// SparkLine
// data: number[]  — inline SVG path, no lib required
// ─────────────────────────────────────────────────────────────────────────────
export function SparkLine({ data = [], color = "var(--cyan)", width = 80, height = 30 }) {
  if (!data || data.length < 2) {
    return html`<span style=${{ color: "var(--muted)", fontSize: "11px" }}>—</span>`;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pad = 2;

  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + ((1 - (v - min) / range) * (height - pad * 2));
    return `${x},${y}`;
  });

  const pathD = "M " + points.join(" L ");
  const areaD = `M ${points[0]} L ${points.join(" L ")} L ${width - pad},${height - pad} L ${pad},${height - pad} Z`;

  return html`
    <svg width=${width} height=${height} style=${{ display: "block" }}>
      <defs>
        <linearGradient id="sg-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor=${color} stopOpacity="0.3"/>
          <stop offset="100%" stopColor=${color} stopOpacity="0"/>
        </linearGradient>
      </defs>
      <path d=${areaD} fill="url(#sg-grad)"/>
      <path d=${pathD} fill="none" stroke=${color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
        style=${{ filter: `drop-shadow(0 0 3px ${color})` }}/>
    </svg>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// TerminalLog
// lines: string[]  — monospace auto-scroll log
// ─────────────────────────────────────────────────────────────────────────────
export function TerminalLog({ lines = [], maxLines = 100, height = 200 }) {
  const ref = useRef(null);
  const visible = lines.slice(-maxLines);

  useEffect(() => {
    if (ref.current) {
      ref.current.scrollTop = ref.current.scrollHeight;
    }
  }, [lines]);

  const colorize = (line) => {
    if (/error|fail|critical/i.test(line)) return "var(--red)";
    if (/warn/i.test(line)) return "var(--yellow)";
    if (/success|ok|healthy|running/i.test(line)) return "var(--green)";
    if (/^\[.*?\]/.test(line)) return "var(--cyan)";
    return "var(--text)";
  };

  return html`
    <div ref=${ref} style=${{
      background: "var(--bg)",
      border: "1px solid var(--border)",
      borderRadius: "6px",
      padding: "12px",
      height: `${height}px`,
      overflowY: "auto",
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: "12px",
      lineHeight: "1.6",
    }}>
      ${visible.length === 0
        ? html`<span style=${{ color: "var(--muted)" }}>Aguardando logs...</span>`
        : visible.map((line, i) => html`
            <div key=${i} style=${{ color: colorize(line), whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              ${line}
            </div>
          `)
      }
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// StepTracker
// Visualiza pipeline de deploy com N steps
// steps: Array<{ label: string, status: 'done'|'active'|'pending'|'error' }>
// ─────────────────────────────────────────────────────────────────────────────
export function StepTracker({ steps = [] }) {
  const statusColor = {
    done:    "var(--green)",
    active:  "var(--cyan)",
    pending: "var(--border2)",
    error:   "var(--red)",
  };

  const statusIcon = {
    done:    "✓",
    active:  "◉",
    pending: "○",
    error:   "✗",
  };

  return html`
    <div style=${{
      display: "flex",
      alignItems: "center",
      gap: "0",
      flexWrap: "wrap",
    }}>
      ${steps.map((step, i) => html`
        <${Fragment} key=${i}>
          <div style=${{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "4px",
            minWidth: "80px",
          }}>
            <div style=${{
              width: "28px",
              height: "28px",
              borderRadius: "50%",
              background: `${statusColor[step.status] || statusColor.pending}20`,
              border: `2px solid ${statusColor[step.status] || statusColor.pending}`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: statusColor[step.status] || statusColor.pending,
              fontSize: "14px",
              fontWeight: "bold",
              boxShadow: step.status === "active" ? `0 0 12px ${statusColor.active}` : "none",
              transition: "all 0.3s ease",
            }}>
              ${statusIcon[step.status] || "○"}
            </div>
            <span style=${{
              fontSize: "10px",
              color: step.status === "pending" ? "var(--muted)" : statusColor[step.status],
              textAlign: "center",
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}>
              ${step.label}
            </span>
          </div>
          ${i < steps.length - 1 && html`
            <div style=${{
              flex: 1,
              height: "2px",
              background: step.status === "done"
                ? "var(--green)"
                : "var(--border)",
              marginBottom: "20px",
              transition: "background 0.3s ease",
              minWidth: "20px",
            }}/>
          `}
        <//>
      `)}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// DrillCard
// Card clicável com hover glow effect
// ─────────────────────────────────────────────────────────────────────────────
export function DrillCard({ title, value, subtitle, status = "unknown", onClick, accent }) {
  const [hovered, setHovered] = useState(false);
  const accentColor = accent || (
    status === "running" || status === "healthy" ? "var(--green)" :
    status === "error"   ? "var(--red)" :
    status === "warning" ? "var(--yellow)" :
    "var(--cyan)"
  );

  return html`
    <div
      onClick=${onClick}
      onMouseEnter=${() => setHovered(true)}
      onMouseLeave=${() => setHovered(false)}
      style=${{
        background: "var(--surface)",
        border: `1px solid ${hovered ? accentColor + "60" : "var(--border)"}`,
        borderRadius: "10px",
        padding: "16px",
        cursor: onClick ? "pointer" : "default",
        transition: "all 0.2s ease",
        boxShadow: hovered ? `0 0 20px ${accentColor}20` : "none",
        transform: hovered && onClick ? "translateY(-2px)" : "none",
        userSelect: "none",
      }}
    >
      <div style=${{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
        <span style=${{ fontSize: "12px", color: "var(--muted)", textTransform: "uppercase", letterSpacing: "0.06em" }}>
          ${title}
        </span>
        ${status !== "unknown" && html`<${StatusBadge} status=${status}/>`}
      </div>
      <div style=${{
        fontSize: "28px",
        fontWeight: "700",
        color: accentColor,
        fontFamily: "'JetBrains Mono', monospace",
        lineHeight: 1,
        marginBottom: "6px",
      }}>
        ${value ?? "—"}
      </div>
      ${subtitle && html`
        <div style=${{ fontSize: "12px", color: "var(--muted)" }}>${subtitle}</div>
      `}
    </div>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-export hooks for use in screens
// ─────────────────────────────────────────────────────────────────────────────
export { h, Fragment, html, useState, useEffect, useRef, useCallback };
