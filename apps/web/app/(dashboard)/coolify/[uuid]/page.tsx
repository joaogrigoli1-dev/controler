"use client";
/**
 * /coolify/[uuid] — drill-down de aplicação Coolify (FASE 4).
 * Header com ações OTP (Deploy/Restart/Stop/Start), histórico de deploys
 * (nocFetch + mock vazio enquanto coolify_list_deployments está 404 na FASE 3),
 * envs mascaradas e logs ao vivo (refresh 10s).
 */
import Link from "next/link";
import { useMemo } from "react";
import { useParams } from "next/navigation";
import useSWR from "swr";
import { api } from "@/lib/api";
import { nocFetch, useNoc } from "@/lib/noc";
import { CoolifyDeploymentListSchema, ragOf, type CoolifyDeploymentRow } from "@/lib/schemas";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { OtpActionButton } from "@/components/noc/OtpActionButton";
import { CardError, EmptyState } from "@/components/noc/CardError";
import { Skeleton, SkeletonRows } from "@/components/noc/Skeleton";
import { DataBadge } from "@/components/noc/DataBadge";
import { ragTextClass } from "@/components/noc/RagBadge";
import { cn } from "@/lib/utils";
import {
  ArrowLeft, GitBranch, ExternalLink, Rocket, RotateCcw, Square, Play,
  Terminal, KeyRound, History
} from "lucide-react";

function deployOk(status: string): boolean {
  return /success|finished|ok/i.test(status);
}
function deployFail(status: string): boolean {
  return /fail|error|cancel/i.test(status);
}

function fmtDuration(d: CoolifyDeploymentRow): string {
  if (typeof d.durationSec === "number") {
    const m = Math.floor(d.durationSec / 60);
    const s = Math.round(d.durationSec % 60);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  if (d.started_at && d.finished_at) {
    const sec = (new Date(d.finished_at).getTime() - new Date(d.started_at).getTime()) / 1000;
    if (Number.isFinite(sec) && sec >= 0) {
      const m = Math.floor(sec / 60);
      const s = Math.round(sec % 60);
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }
  }
  return "—";
}

export default function CoolifyAppDrillPage() {
  const params = useParams<{ uuid: string }>();
  const uuid = decodeURIComponent(String(params?.uuid ?? ""));

  const { data: app, error: appError, mutate: refreshApp } = useSWR(
    uuid ? `coolify-app-${uuid}` : null,
    () => api.coolifyApp(uuid),
    { refreshInterval: 30000 }
  );
  const { data: envs, error: envsError } = useSWR(
    uuid ? `coolify-envs-${uuid}` : null,
    () => api.coolifyEnvs(uuid)
  );
  const { data: logs, error: logsError } = useSWR(
    uuid ? `coolify-logs-${uuid}` : null,
    () => api.coolifyLogs(uuid, 200),
    { refreshInterval: 10000 }
  );
  const deployments = useNoc(
    uuid ? `coolify-deployments-${uuid}` : null,
    () =>
      nocFetch(`/coolify/apps/${uuid}/deployments`, CoolifyDeploymentListSchema, {
        mock: () => []
      }),
    60_000
  );

  const status = String(app?.status ?? "");
  const badge = status.includes("unhealthy")
    ? "unhealthy"
    : status.includes("exited")
      ? "exited"
      : status.includes("healthy")
        ? "healthy"
        : status.includes("running")
          ? "running"
          : "stopped";
  const fqdn = String(app?.fqdn || "").split(",")[0];

  const deps = deployments.data ?? [];
  const successRate = useMemo(() => {
    const withStatus = deps.filter(d => d.status);
    if (!withStatus.length) return null;
    const ok = withStatus.filter(d => deployOk(String(d.status))).length;
    return (ok / withStatus.length) * 100;
  }, [deps]);

  const refreshAll = () => {
    void refreshApp();
    deployments.refresh();
  };

  return (
    <div className="space-y-6 animate-fade-up">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link href="/coolify" className="text-xs text-white/60 hover:text-white/70 flex items-center gap-1 mb-1.5">
            <ArrowLeft size={12} /> Coolify
          </Link>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-display font-bold text-xl truncate">{app?.name ?? uuid}</h1>
            {app && <StatusBadge status={badge} pulse />}
          </div>
          <div className="text-xs text-white/60 mt-1 flex items-center gap-3 flex-wrap">
            {fqdn && (
              <a
                href={`https://${fqdn}`}
                target="_blank"
                rel="noreferrer"
                className="text-cyan hover:underline text-mono flex items-center gap-1"
              >
                {fqdn} <ExternalLink size={10} />
              </a>
            )}
            <span className="flex items-center gap-1"><GitBranch size={11} /> {app?.git_branch || "main"}</span>
            <span className="text-mono">{(app?.git_commit_sha || "").slice(0, 7) || "—"}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <OtpActionButton
            label="Deploy"
            icon={<Rocket size={13} />}
            className="btn-primary"
            confirmText={`Disparar um novo deploy (force) da aplicação "${app?.name ?? uuid}".`}
            action={otp => api.coolifyDeploy(uuid, otp)}
            onDone={refreshAll}
          />
          <OtpActionButton
            label="Restart"
            icon={<RotateCcw size={13} />}
            confirmText={`Reiniciar a aplicação "${app?.name ?? uuid}". Ela ficará indisponível por alguns segundos.`}
            action={otp => api.coolifyRestart(uuid, otp)}
            onDone={refreshAll}
          />
          <OtpActionButton
            label="Stop"
            icon={<Square size={13} />}
            danger
            confirmText={`Parar a aplicação "${app?.name ?? uuid}". Ela ficará FORA DO AR até um start manual.`}
            action={otp => api.coolifyStop(uuid, otp)}
            onDone={refreshAll}
          />
          <OtpActionButton
            label="Start"
            icon={<Play size={13} />}
            confirmText={`Iniciar a aplicação "${app?.name ?? uuid}".`}
            action={otp => api.coolifyStart(uuid, otp)}
            onDone={refreshAll}
          />
        </div>
      </div>

      {appError && <CardError message={`Erro ao carregar a aplicação: ${appError.message}`} onRetry={() => void refreshApp()} />}
      {!app && !appError && <Skeleton className="h-16" />}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Histórico de deploys */}
        <div className="lg:col-span-2 glass-card p-5">
          <div className="flex items-center justify-between mb-3">
            <div className="section-title mb-0 flex items-center gap-2">
              <History size={13} className="text-cyan" /> Histórico de deploys
            </div>
            <div className="flex items-center gap-2">
              {successRate != null && (
                <span className={cn("text-xs text-mono", ragTextClass(ragOf(successRate, 90, 75, true)))}>
                  {successRate.toFixed(0)}% sucesso
                </span>
              )}
              <DataBadge source={deployments.source} stale={deployments.stale} />
            </div>
          </div>

          {deployments.error && !deployments.data && (
            <CardError message={deployments.error.message} onRetry={deployments.refresh} />
          )}
          {deployments.isLoading && !deployments.data && <SkeletonRows n={6} />}
          {deployments.data && deps.length === 0 && (
            <EmptyState message="Histórico de deploys indisponível (fonte em resolução na FASE 3 — coolify_list_deployments 404)." />
          )}
          {deps.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-white/60 text-[10px] uppercase tracking-widest">
                  <tr>
                    <th className="text-left py-2">Quando</th>
                    <th className="text-left">Status</th>
                    <th className="text-left">Commit</th>
                    <th className="text-left">Mensagem</th>
                    <th className="text-right">Duração</th>
                  </tr>
                </thead>
                <tbody>
                  {deps.map((d, i) => {
                    const s = String(d.status ?? "—");
                    const when = d.created_at ?? d.started_at ?? d.finished_at;
                    return (
                      <tr key={d.deployment_uuid ?? d.id ?? i} className="border-t border-white/5">
                        <td className="py-2 text-mono text-white/70 whitespace-nowrap">
                          {when ? new Date(when).toLocaleString("pt-BR") : "—"}
                        </td>
                        <td>
                          <StatusBadge status={deployOk(s) ? "green" : deployFail(s) ? "red" : "yellow"} label={s} />
                        </td>
                        <td className="text-mono text-white/70">{(d.commit || "").slice(0, 7) || "—"}</td>
                        <td className="text-white/60 truncate max-w-[260px]" title={d.commit_message ?? undefined}>
                          {d.commit_message || "—"}
                        </td>
                        <td className="text-right text-mono text-white/60 whitespace-nowrap">{fmtDuration(d)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Envs + Logs */}
        <div className="space-y-4">
          <div className="glass-card p-5">
            <div className="section-title flex items-center gap-2">
              <KeyRound size={13} className="text-accent" /> Variáveis de ambiente
            </div>
            {envsError && <p className="text-xs text-red">Erro ao carregar envs: {envsError.message}</p>}
            {!envs && !envsError && <SkeletonRows n={5} />}
            {Array.isArray(envs) && envs.length === 0 && <EmptyState message="Nenhuma variável configurada." />}
            {Array.isArray(envs) && envs.length > 0 && (
              <div className="space-y-2 text-xs max-h-[260px] overflow-y-auto">
                {envs.map((e: any) => (
                  <div key={e.id ?? e.key} className="flex items-center justify-between gap-2 p-1.5 rounded bg-white/[0.03]">
                    <span className="text-mono text-white/80 truncate">{e.key}</span>
                    <span className="text-mono text-white/60 shrink-0">
                      {e.is_secret ? "••••" : String(e.value ?? "").slice(0, 20)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="glass-card p-5">
            <div className="flex items-center gap-2 mb-2">
              <Terminal size={14} className="text-cyan" />
              <span className="section-title mb-0">Logs (200 linhas)</span>
            </div>
            <pre className="text-[10px] text-mono text-white/60 bg-black/40 p-3 rounded h-[300px] overflow-auto whitespace-pre-wrap">
              {logsError
                ? `Erro ao carregar logs: ${logsError.message}\nAtualização automática em 10s…`
                : (logs?.logs || "Carregando…")}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
