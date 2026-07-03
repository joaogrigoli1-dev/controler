"use client";
/**
 * /coolify — visão geral das aplicações Coolify (FASE 4).
 * KPIs + seção "Apps com problema" no topo (com ações OTP) + grade de apps
 * (card → drill /coolify/[uuid]) + painel lateral de deploys globais e
 * taxa de sucesso por projeto.
 */
import Link from "next/link";
import useSWR from "swr";
import { useMemo } from "react";
import { api } from "@/lib/api";
import { ragOf } from "@/lib/schemas";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { KpiTile } from "@/components/ui/KpiTile";
import { OtpActionButton } from "@/components/noc/OtpActionButton";
import { CardError, EmptyState } from "@/components/noc/CardError";
import { SkeletonRows } from "@/components/noc/Skeleton";
import { ragDotClass } from "@/components/noc/RagBadge";
import { cn } from "@/lib/utils";
import {
  Boxes, GitBranch, ExternalLink, RefreshCcw, AlertTriangle,
  Rocket, RotateCcw, CheckCircle2, History
} from "lucide-react";

interface DeployStat {
  total?: number | null;
  success?: number | null;
  failed?: number | null;
  [key: string]: unknown;
}

function isProblem(a: any): boolean {
  const s = String(a?.status ?? "");
  return s.includes("exited") || s.includes("unhealthy");
}

function appBadgeStatus(a: any): string {
  const s = String(a?.status ?? "");
  if (s.includes("unhealthy")) return "unhealthy";
  if (s.includes("exited")) return "exited";
  if (s.includes("healthy")) return "healthy";
  if (s.includes("running")) return "running";
  return "stopped";
}

export default function CoolifyPage() {
  const { data: apps, error: appsError, mutate } = useSWR("coolify-list", () => api.coolifyApps(), { refreshInterval: 30000 });
  const { data: recentDeploys, error: deploysError } = useSWR("deploys-global", () => api.deploys(), { refreshInterval: 60000 });
  const { data: stats, error: statsError } = useSWR("deploy-stats", () => api.deployStats(), { refreshInterval: 60000 });

  const list: any[] = apps || [];
  const total = list.length;
  const healthyRunning = list.filter(a => {
    const s = String(a?.status ?? "");
    return s.includes("running") && s.includes("healthy") && !s.includes("unhealthy");
  }).length;
  const problems = list.filter(isProblem);

  // deployStats: objeto por projeto { total, success, failed, avgDuration } (deploys.service.ts) → agrega tudo
  const { globalPct, statEntries } = useMemo(() => {
    const entries = Object.entries((stats ?? {}) as Record<string, DeployStat>);
    let ok = 0;
    let fail = 0;
    for (const [, s] of entries) {
      ok += Number(s?.success ?? 0);
      fail += Number(s?.failed ?? 0);
    }
    const totalDeploys = ok + fail;
    return {
      globalPct: totalDeploys > 0 ? (ok / totalDeploys) * 100 : null,
      statEntries: entries
    };
  }, [stats]);

  return (
    <div className="space-y-6 animate-fade-up">
      {/* KPIs */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiTile label="Apps" value={apps ? total : "…"} icon={<Boxes size={14} />} accent="accent" />
        <KpiTile label="Running · healthy" value={apps ? healthyRunning : "…"} icon={<CheckCircle2 size={14} />} accent="green" sub={`de ${total} apps`} />
        <KpiTile
          label="Exited / unhealthy"
          value={problems.length > 0 ? <span className="text-red animate-pulse">{problems.length}</span> : 0}
          icon={<AlertTriangle size={14} />}
          accent={problems.length > 0 ? "red" : "green"}
          sub={problems.length > 0 ? "ação necessária" : "tudo ok"}
        />
        <KpiTile
          label="Sucesso de deploys"
          value={globalPct != null ? `${globalPct.toFixed(0)}%` : "—"}
          icon={<Rocket size={14} />}
          accent={globalPct != null ? (ragOf(globalPct, 90, 75, true) === "crit" ? "red" : ragOf(globalPct, 90, 75, true) === "warn" ? "yellow" : "green") : undefined}
          sub="todos os projetos"
        />
      </div>

      {/* Apps com problema — SEMPRE no topo quando houver */}
      {problems.length > 0 && (
        <div className="space-y-3">
          <div className="section-title mb-0 flex items-center gap-2 text-red">
            <AlertTriangle size={14} /> Apps com problema ({problems.length})
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {problems.map((a: any) => (
              <div key={a.uuid} className="glass-card p-5 border border-red/40">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={`/coolify/${a.uuid}`} className="text-display font-semibold hover:underline">
                      {a.name}
                    </Link>
                    <div className="text-xs text-white/60 text-mono truncate mt-0.5">{a.status || "—"}</div>
                  </div>
                  <StatusBadge status={appBadgeStatus(a)} pulse />
                </div>
                <div className="mt-3 flex items-center gap-2">
                  <OtpActionButton
                    label="Restart"
                    icon={<RotateCcw size={13} />}
                    danger
                    confirmText={`Reiniciar a aplicação "${a.name}" no Coolify.`}
                    action={otp => api.coolifyRestart(a.uuid, otp)}
                    onDone={() => void mutate()}
                  />
                  <OtpActionButton
                    label="Deploy"
                    icon={<Rocket size={13} />}
                    confirmText={`Disparar um novo deploy (force) da aplicação "${a.name}".`}
                    action={otp => api.coolifyDeploy(a.uuid, otp)}
                    onDone={() => void mutate()}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Grade de apps */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <div className="text-sm text-white/60">{total} aplicações</div>
            <button onClick={() => void mutate()} className="btn"><RefreshCcw size={12} /> Refresh</button>
          </div>

          {appsError && (
            <CardError message={`Erro ao listar aplicações: ${appsError.message}`} onRetry={() => void mutate()} />
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {list.map((a: any) => {
              const fqdn = String(a.fqdn || "").split(",")[0];
              return (
                <Link
                  key={a.uuid}
                  href={`/coolify/${a.uuid}`}
                  className={cn(
                    "glass-card p-5 block transition-all hover:ring-1 hover:ring-accent/60",
                    isProblem(a) && "border border-red/30"
                  )}
                >
                  <div className="flex items-start justify-between">
                    <div className="min-w-0">
                      <div className="text-display font-semibold truncate">{a.name}</div>
                      {fqdn ? (
                        <span
                          role="link"
                          tabIndex={0}
                          onClick={e => { e.preventDefault(); e.stopPropagation(); window.open(`https://${fqdn}`, "_blank", "noopener,noreferrer"); }}
                          onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); window.open(`https://${fqdn}`, "_blank", "noopener,noreferrer"); } }}
                          className="text-xs text-cyan hover:underline text-mono flex items-center gap-1 mt-0.5 cursor-pointer"
                        >
                          {fqdn} <ExternalLink size={10} />
                        </span>
                      ) : (
                        <span className="text-xs text-white/30 text-mono mt-0.5 block">sem fqdn</span>
                      )}
                    </div>
                    <StatusBadge status={appBadgeStatus(a)} pulse />
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div className="text-white/40 flex items-center gap-1"><GitBranch size={11} /> {a.git_branch || "main"}</div>
                    <div className="text-white/40 text-right text-mono">{(a.git_commit_sha || "").slice(0, 7) || "—"}</div>
                  </div>
                  <div className="text-[10px] text-white/30 text-mono mt-2 truncate">{a.uuid}</div>
                </Link>
              );
            })}
            {!apps && !appsError && [1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="glass-card h-32 animate-pulse" />
            ))}
          </div>
        </div>

        {/* Painel lateral: deploys globais + stats por projeto */}
        <div className="space-y-4">
          <div className="glass-card p-5">
            <div className="section-title flex items-center gap-2">
              <History size={13} className="text-cyan" /> Últimos deploys
            </div>
            {deploysError && <p className="text-xs text-red">Erro ao carregar deploys: {deploysError.message}</p>}
            {!recentDeploys && !deploysError && <SkeletonRows n={5} />}
            {Array.isArray(recentDeploys) && recentDeploys.length === 0 && (
              <EmptyState message="Nenhum deploy registrado." />
            )}
            {Array.isArray(recentDeploys) && recentDeploys.length > 0 && (
              <div className="space-y-2">
                {recentDeploys.slice(0, 10).map((d: any, i: number) => {
                  const when = d.createdAt ?? d.created_at ?? d.finishedAt ?? d.finished_at ?? d.ts;
                  const status = String(d.status ?? "—");
                  const ok = /success|finished|ok/i.test(status);
                  const failed = /fail|error/i.test(status);
                  return (
                    <div key={d.id ?? i} className="flex items-center justify-between gap-2 p-2 rounded bg-white/[0.02]">
                      <div className="min-w-0">
                        <div className="text-xs text-white/80 truncate">{d.project ?? d.projectName ?? d.app ?? d.name ?? "—"}</div>
                        <div className="text-[10px] text-white/40 text-mono">
                          {when ? new Date(when).toLocaleString("pt-BR") : "—"}
                        </div>
                      </div>
                      <StatusBadge status={ok ? "green" : failed ? "red" : "yellow"} label={status} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="glass-card p-5">
            <div className="section-title">Sucesso por projeto</div>
            {statsError && <p className="text-xs text-red">Erro ao carregar estatísticas: {statsError.message}</p>}
            {!stats && !statsError && <SkeletonRows n={4} />}
            {stats && statEntries.length === 0 && <EmptyState message="Sem estatísticas de deploy." />}
            {statEntries.length > 0 && (
              <div className="space-y-3">
                {statEntries.map(([project, s]) => {
                  const ok = Number(s?.success ?? 0);
                  const fail = Number(s?.failed ?? 0);
                  const totalP = ok + fail;
                  const pct = totalP > 0 ? (ok / totalP) * 100 : null;
                  const rag = pct != null ? ragOf(pct, 90, 75, true) : "stale";
                  return (
                    <div key={project}>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-white/80 truncate">{project}</span>
                        <span className="text-mono text-white/60">
                          {ok} ok · {fail} fail {pct != null ? `· ${pct.toFixed(0)}%` : ""}
                        </span>
                      </div>
                      <div className="h-1.5 mt-1 rounded-full bg-white/[0.06] overflow-hidden">
                        <div
                          className={cn("h-full rounded-full", ragDotClass(rag))}
                          style={{ width: `${pct ?? 0}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
