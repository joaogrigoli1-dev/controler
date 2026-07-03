import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("bg-white/[0.04] rounded-md animate-pulse", className)} />;
}

export function SkeletonRows({ n = 5, className }: { n?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-8" />
      ))}
    </div>
  );
}

export function CardSkeleton({ height = 160 }: { height?: number }) {
  return <div className="glass-card animate-pulse" style={{ height }} />;
}
