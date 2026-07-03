import { severityDotClass } from "@/lib/utils";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { EmptyState } from "./CardError";

export interface TimelineItem {
  id?: string | number;
  ts: string;
  title: string;
  severity?: string;
  meta?: string;
}

/** EventTimeline — lista compacta de eventos com dot de severidade. */
export function EventTimeline({ items, emptyMessage = "Nenhum evento no período." }: { items: TimelineItem[]; emptyMessage?: string }) {
  if (!items.length) return <EmptyState message={emptyMessage} />;
  return (
    <div className="space-y-2">
      {items.map((e, i) => (
        <div key={e.id ?? i} className="flex items-start gap-3 p-2.5 rounded-md hover:bg-white/[0.03]">
          <span className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${severityDotClass(e.severity ?? "info")}`} />
          <div className="flex-1 min-w-0">
            <div className="text-sm truncate">{e.title}</div>
            <div className="text-[10px] text-white/40 text-mono">
              {new Date(e.ts).toLocaleString("pt-BR")} {e.meta ? `· ${e.meta}` : ""}
            </div>
          </div>
          {e.severity && <StatusBadge status={e.severity} />}
        </div>
      ))}
    </div>
  );
}
