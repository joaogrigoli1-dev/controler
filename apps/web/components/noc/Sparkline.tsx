/**
 * Sparkline — SVG puro (Fase 1 §d: 40+ instâncias, Recharts seria pesado).
 */
export function Sparkline({
  data,
  width = 88,
  height = 26,
  stroke = "hsl(var(--cyan))",
  strokeWidth = 1.5,
  fillOpacity = 0.12
}: {
  data: Array<number | null | undefined>;
  width?: number;
  height?: number;
  stroke?: string;
  strokeWidth?: number;
  fillOpacity?: number;
}) {
  const vals = data.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
  if (vals.length < 2) {
    return <svg width={width} height={height} aria-hidden="true" />;
  }
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 2;
  const step = (width - pad * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => {
    const x = pad + i * step;
    const y = pad + (height - pad * 2) * (1 - (v - min) / span);
    return [x, y] as const;
  });
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${pad},${height - pad} ${line} ${(pad + (vals.length - 1) * step).toFixed(1)},${height - pad}`;
  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0">
      <polygon points={area} fill={stroke} opacity={fillOpacity} />
      <polyline points={line} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
