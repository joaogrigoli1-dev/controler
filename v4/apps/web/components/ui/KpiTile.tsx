import { cn } from "@/lib/utils";
import { ReactNode } from "react";

interface Props {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  delta?: number;
  trend?: "up" | "down" | "flat";
  icon?: ReactNode;
  accent?: "cyan" | "green" | "yellow" | "red" | "accent";
}

const ACCENT_MAP = {
  cyan: "border-cyan/30 shadow-cyan/10",
  green: "border-green/30 shadow-green/10",
  yellow: "border-yellow/30 shadow-yellow/10",
  red: "border-red/30 shadow-red/10",
  accent: "border-accent/30 shadow-accent/10"
};

export function KpiTile({ label, value, sub, delta, trend, icon, accent }: Props) {
  return (
    <div className={cn("kpi-tile", accent && ACCENT_MAP[accent])}>
      <div className="flex items-start justify-between text-xs uppercase tracking-widest text-white/40">
        <span>{label}</span>
        {icon && <span className="opacity-60">{icon}</span>}
      </div>
      <div className="text-3xl font-bold text-mono mt-1">{value}</div>
      {(sub || delta !== undefined) && (
        <div className="text-xs text-white/50 flex items-center gap-2 mt-1">
          {delta !== undefined && (
            <span className={cn(
              "text-mono",
              trend === "up" ? "text-green" : trend === "down" ? "text-red" : "text-white/40"
            )}>
              {trend === "up" ? "▲" : trend === "down" ? "▼" : "■"} {Math.abs(delta)}
            </span>
          )}
          {sub}
        </div>
      )}
    </div>
  );
}
