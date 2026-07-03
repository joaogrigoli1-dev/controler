/**
 * DeploysScheduler — FASE 3 (Gap #6): captura de deploys do Coolify (fonte de verdade).
 *
 * A cada 5min, para cada app do Coolify:
 *   1. upsert idempotente dos deployments recentes em DeployHistory (chave: deploymentUuid).
 *      Deploy que TRANSICIONA para failed → alerta CRITICAL + evento na timeline.
 *   2. detecção de apps `exited`/`unhealthy` no status composto → alerta CRITICAL
 *      (catálogo A.3, ruleKey coolify_unhealthy_<name>).
 *
 * A captura vivia no metrics.scheduler (realtime) — migrada para cá na FASE 3.
 *
 * Anti-flood: o cooldown do AlertsService NÃO se aplica a severity critical, então
 * este scheduler mantém guarda própria no Redis (TTL) antes de despachar críticos.
 * Tolerante a erro por app (try/catch por iteração) — o job nunca derruba o app.
 *
 * Decisão 5 — Supressão de alertas para apps reconhecidamente offline:
 *   Apps do Coolify INTENCIONALMENTE parados (exited/unhealthy conhecido) não devem
 *   gerar alerta WhatsApp/SMS a cada ciclo. A lista de UUIDs "acknowledged offline"
 *   tem default embutido (ver DEFAULT_ACK_OFFLINE_UUIDS) e pode ser sobrescrita pela
 *   env `NOC_COOLIFY_ACK_OFFLINE_UUIDS` (CSV de UUIDs; se definida, SUBSTITUI o default).
 *   Para esses apps o estado continua sendo REGISTRADO (timeline/DB), mas o alerta
 *   é suprimido. Qualquer outro app mantém o comportamento normal (alerta CRITICAL).
 */

import { Injectable, Logger } from "@nestjs/common";
import { Interval } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma.service";
import { RedisService } from "../common/redis.service";
import { CoolifyService } from "../coolify/coolify.service";
import { AlertsService } from "../alerts/alerts.service";
import { TimelineService } from "../timeline/timeline.service";

const SYNC_INTERVAL_MS = 5 * 60_000; // 5min
const MAX_DEPLOYMENTS_PER_APP = 20; // só os recentes; upsert cobre o resto ao longo do tempo
const RECENT_FAIL_WINDOW_MS = 30 * 60_000; // não alertar falhas antigas em backfill
const ALERT_GUARD_PREFIX = "deploys:alerted:";

/** Decisão 5: UUIDs de apps Coolify reconhecidamente offline (alerta suprimido). */
const DEFAULT_ACK_OFFLINE_UUIDS = [
  "v8so4ocgkkkk8ows48skggcg", // passaro-professor
  "x4g4sgw48s4s84wg8kkggs8g", // manalista
  "m56hx08nsdc65kxvtadczbfv" // apptecph-web
];

/** Resolve a lista de "acknowledged offline": env `NOC_COOLIFY_ACK_OFFLINE_UUIDS` (CSV) sobrescreve o default. */
function ackOfflineUuids(): Set<string> {
  const env = (process.env.NOC_COOLIFY_ACK_OFFLINE_UUIDS || "").trim();
  const list = env
    ? env.split(",").map(s => s.trim().toLowerCase()).filter(Boolean)
    : DEFAULT_ACK_OFFLINE_UUIDS;
  return new Set(list);
}

/** Mapeia o status cru do Coolify para o vocabulário do DeployHistory. */
function mapDeployStatus(raw: string | null | undefined): string {
  const s = (raw || "").toLowerCase();
  if (s.includes("finished") || s.includes("success")) return "success";
  if (s.includes("failed") || s.includes("error")) return "failed";
  if (s.includes("progress") || s.includes("queued") || s.includes("running")) return "running";
  if (s.includes("cancel")) return "cancelled";
  return s || "unknown";
}

@Injectable()
export class DeploysScheduler {
  private readonly log = new Logger("DeploysScheduler");

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly coolify: CoolifyService,
    private readonly alerts: AlertsService,
    private readonly timeline: TimelineService
  ) {}

  @Interval("coolify-deploys-sync", SYNC_INTERVAL_MS)
  async tick() {
    let apps: any[] = [];
    try {
      const res = await this.coolify.listApplications();
      apps = Array.isArray(res) ? res : [];
    } catch (err: any) {
      this.log.warn(`listApplications falhou: ${err?.message}`);
      return;
    }
    for (const app of apps) {
      if (!app?.uuid || !app?.name) continue;
      try {
        await this.syncApp(app);
      } catch (err: any) {
        this.log.warn(`syncApp(${app.name}): ${err?.message}`);
      }
      try {
        await this.checkAppHealth(app);
      } catch (err: any) {
        this.log.warn(`checkAppHealth(${app.name}): ${err?.message}`);
      }
    }
  }

  /** 1. Upsert idempotente dos deployments recentes + alerta em transição para failed. */
  private async syncApp(app: any) {
    const deployments = await this.coolify.listDeployments(app.uuid);
    const recent = (deployments || [])
      .filter((d: any) => d?.deployment_uuid)
      .slice(0, MAX_DEPLOYMENTS_PER_APP);
    if (!recent.length) return;

    // Snapshot do status anterior — necessário p/ detectar a TRANSIÇÃO para failed
    const prevRows = await this.prisma.deployHistory.findMany({
      where: { deploymentUuid: { in: recent.map((d: any) => d.deployment_uuid) } },
      select: { deploymentUuid: true, status: true }
    });
    const prevByUuid = new Map(prevRows.map(r => [r.deploymentUuid as string, r.status]));

    for (const d of recent) {
      const status = mapDeployStatus(d.status);
      const startedAt = d.started_at ? new Date(d.started_at) : d.created_at ? new Date(d.created_at) : new Date();
      const finishedAt = d.finished_at ? new Date(d.finished_at) : null;
      const data = {
        project: app.name as string,
        coolifyUuid: app.uuid as string,
        status,
        commitSha: d.commit ?? null,
        commitMsg: d.commit_message ?? null,
        branch: app.git_branch ?? null,
        durationSec: d.durationSec ?? null,
        triggeredBy: "coolify",
        startedAt,
        finishedAt,
        queuedAt: d.created_at ? new Date(d.created_at) : null
      };
      await this.prisma.deployHistory.upsert({
        where: { deploymentUuid: d.deployment_uuid },
        update: data,
        create: { ...data, deploymentUuid: d.deployment_uuid }
      });

      const prev = prevByUuid.get(d.deployment_uuid);
      const transitionedToFail = status === "failed" && prev !== "failed";
      // Só alerta falha recente (evita disparo em backfill de histórico antigo)
      const isRecent = !finishedAt || Date.now() - finishedAt.getTime() < RECENT_FAIL_WINDOW_MS;
      if (transitionedToFail && isRecent) {
        await this.notifyDeployFailed(app, d);
      }
    }
  }

  private async notifyDeployFailed(app: any, d: any) {
    // Guarda por deployment_uuid: no máximo 1 alerta por deploy que falhou
    const guardKey = `${ALERT_GUARD_PREFIX}deploy_failed:${d.deployment_uuid}`;
    const already = await this.redis.client.get(guardKey).catch(() => null);
    if (already) return;
    await this.redis.client.setex(guardKey, 24 * 3600, "1").catch(() => {});

    const commit = (d.commit || "").slice(0, 8);
    await this.alerts
      .dispatch({
        ruleKey: `deploy_failed_${app.name}`,
        severity: "critical",
        title: `Deploy FALHOU: ${app.name}`,
        message: `Deploy ${d.deployment_uuid} do app ${app.name} falhou.${commit ? ` Commit ${commit}.` : ""}${d.commit_message ? ` "${String(d.commit_message).slice(0, 80)}"` : ""}`,
        metadata: { deploymentUuid: d.deployment_uuid, coolifyUuid: app.uuid, project: app.name }
      })
      .catch(err => this.log.warn(`dispatch deploy_failed: ${err?.message}`));
    await this.timeline
      .log({
        eventType: "deploy",
        title: `Deploy falhou em ${app.name}`,
        severity: "critical",
        project: app.name,
        detail: `deployment ${d.deployment_uuid}${commit ? ` — commit ${commit}` : ""}`,
        actor: "scheduler",
        metadata: { ruleKey: `deploy_failed_${app.name}`, deploymentUuid: d.deployment_uuid }
      })
      .catch(err => this.log.warn(`timeline deploy_failed: ${err?.message}`));
  }

  /** 2. Catálogo A.3: app com status composto exited/unhealthy → CRITICAL. */
  private async checkAppHealth(app: any) {
    const status = String(app.status || "").toLowerCase();
    const bad = status.includes("exited") || status.includes("unhealthy");
    if (!bad) return;

    // Guarda anti-flood (critical ignora o cooldown do AlertsService): 1 alerta / 30min / app
    const guardKey = `${ALERT_GUARD_PREFIX}coolify_unhealthy:${app.name}`;
    const already = await this.redis.client.get(guardKey).catch(() => null);
    if (already) return;
    await this.redis.client.setex(guardKey, 30 * 60, "1").catch(() => {});

    // Decisão 5: app reconhecidamente offline → registra o estado (timeline/DB),
    // mas NÃO dispara alerta (WhatsApp/SMS). Guarda Redis acima limita a 1 registro / 30min.
    if (ackOfflineUuids().has(String(app.uuid).toLowerCase())) {
      this.log.log(`app ${app.name} (${app.uuid}) está na ack-offline list; alerta suprimido (status="${app.status}")`);
      await this.timeline
        .log({
          eventType: "coolify",
          title: `App ${app.name} está ${status} (ack-offline)`,
          severity: "info",
          project: app.name,
          detail: `Status composto "${app.status}" registrado; alerta suprimido — app na lista acknowledged-offline (NOC_COOLIFY_ACK_OFFLINE_UUIDS).`,
          actor: "scheduler",
          metadata: { ruleKey: `coolify_unhealthy_${app.name}`, coolifyUuid: app.uuid, status: app.status, ackOffline: true }
        })
        .catch(err => this.log.warn(`timeline ack-offline(${app.name}): ${err?.message}`));
      return;
    }

    await this.alerts
      .dispatch({
        ruleKey: `coolify_unhealthy_${app.name}`,
        severity: "critical",
        title: `App ${app.name} está ${status}`,
        message: `O app ${app.name} no Coolify reporta status "${app.status}". Verifique em /coolify.`,
        metadata: { coolifyUuid: app.uuid, status: app.status }
      })
      .catch(err => this.log.warn(`dispatch coolify_unhealthy: ${err?.message}`));
  }
}
