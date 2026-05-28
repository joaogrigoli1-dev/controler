"use client";
interface Props {
  value: number;
  max?: number;
  label: string;
  size?: number;
  thresholds?: [number, number]; // [warning, critical]
}
export function Gauge({ value, max = 100, label, size = 120, thresholds = [60, 85] }: Props) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100));
  const r = size / 2 - 8;
  const c = 2 * Math.PI * r;
  const offset = c - (pct / 100) * c * 0.75; // 270° arc
  const color = pct >= thresholds[1] ? "var(--red)" : pct >= thresholds[0] ? "var(--yellow)" : "var(--green)";
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(255,255,255,0.06)"
          strokeWidth="8"
          strokeDasharray={c}
          strokeDashoffset={c * 0.25}
          transform={`rotate(135 ${size / 2} ${size / 2})`}
          strokeLinecap="round"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={`hsl(${color})`}
          strokeWidth="8"
          strokeDasharray={c}
          strokeDashoffset={offset + c * 0.25}
          transform={`rotate(135 ${size / 2} ${size / 2})`}
          strokeLinecap="round"
          style={{ transition: "stroke-dashoffset 600ms cubic-bezier(0.32,0.72,0,1)", filter: `drop-shadow(0 0 8px hsl(${color}))` }}
        />
        <text x="50%" y="50%" dy="-2" textAnchor="middle" className="fill-white font-bold text-mono" fontSize={size * 0.22}>
          {value.toFixed(0)}%
        </text>
        <text x="50%" y="50%" dy="18" textAnchor="middle" className="fill-white/40 uppercase tracking-widest" fontSize={9}>
          {label}
        </text>
      </svg>
    </div>
  );
}
