import { cn } from "@/lib/utils";

interface Props {
  status: string;
  pulse?: boolean;
  label?: string;
}

const COLOR_MAP: Record<string, string> = {
  green: "badge-green",
  healthy: "badge-green",
  running: "badge-green",
  ok: "badge-green",
  yellow: "badge-yellow",
  warning: "badge-yellow",
  degraded: "badge-yellow",
  starting: "badge-yellow",
  red: "badge-red",
  critical: "badge-red",
  unhealthy: "badge-red",
  down: "badge-red",
  exited: "badge-muted",
  stopped: "badge-muted",
  cyan: "badge-cyan",
  info: "badge-cyan"
};

export function StatusBadge({ status, pulse, label }: Props) {
  const cls = COLOR_MAP[status.toLowerCase()] || "badge-muted";
  return (
    <span className={cn("badge", cls)}>
      {pulse && <span className="pulse-dot" style={{ background: "currentColor" }} />}
      {label || status}
    </span>
  );
}
