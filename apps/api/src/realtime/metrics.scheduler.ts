/**
 * MetricsScheduler — jobs que rodam continuamente:
 *   - host-metrics:      30s   snapshot + WS emit + alertas thresholds
 *   - container-metrics: 30s   snapshot + WS emit + alertas containers down
 *   - sites-check:       5min  ping HTTP nos sites + atualiza Site.statusCode
 *   - apis-ping:         10min ping nas ProjectApi com healthUrl
 *   - coolify-deploys:   2min  poll Coolify, registra novos deploys em DeployHistory
 *   - daily-digest:      08:00 BRT  resumo via WhatsApp
 *   - cleanup:           03:00 BRT  remove snapshots > 30 dias
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron, Interval } from "@nestjs/schedule";
import { Srv1Service } from "../srv1/srv1.service";
import { PrismaService } from "../common/prisma.service";
import { RealtimeGateway } from "./realtime.gateway";
import { TimelineService } from "../timeline/timeline.service";
import { AlertsService } from "../alerts/alerts.service";
import { HestiaService } from "../hestia/hestia.service";
import { ApisService } from "../apis/apis.service";
import { CoolifyService } from "../coolify/coolify.service";

@Injectable()
export class MetricsScheduler {
  private readonly log = new Logger("Scheduler");
  // Track containers que estavam UP no último ciclo (detecta novos down)
  private lastSeenRunning = new Set<string>();
  // Track ultimo deploy SHA por app (para detectar deploys novos)
  private lastDeploySha = new Map<string, string>();

  constructor(
    private readonly srv1: Srv1Service,
    private readonly prisma: PrismaService,
    private readonly gw: RealtimeGateway,
    private readonly timeline: TimelineService,
    private readonly alerts: AlertsService,
    private readonly hestia: HestiaService,
    private readonly apis: ApisService,
    private readonly coolify: CoolifyService
  ) {}

  @Interval("host-metrics", 60_000)
  async hostMetricsTick() {
    try {
      const m = await this.srv1.getHostMetrics();
      await this.prisma.hostMetricSnapshot.create({
        data: {
          cpuPercent: m.cpuPercent,
          loadAvg1m: m.loadAvg[0], loadAvg5m: m.loadAvg[1], loadAvg15m: m.loadAvg[2],
          memTotalMb: m.memTotalMb, memUsedMb: m.memUsedMb,
          diskTotalGb: m.diskTotalGb, diskUsedGb: m.diskUsedGb,
          swapUsedMb: m.swapUsedMb,
          netInBytes: BigInt(m.netInBytes || 0), netOutBytes: BigInt(m.netOutBytes || 0)
        }
      });
      this.gw.emitHostMetrics({ ...m, ts: Date.now() });

      // Thresholds → alertas (sem flood: AlertsService tem cooldown 30min)
      if (m.cpuPercent > 85) {
        await this.alerts.dispatch({ ruleKey: "host_cpu_high", severity: "warning", title: "CPU SRV1 alta", message: `CPU em ${m.cpuPercent.toFixed(1)}% (load ${m.loadAvg[0].toFixed(2)})` });
      }
      if (m.memPercent > 90) {
        await this.alerts.dispatch({ ruleKey: "host_mem_high", severity: "warning", title: "RAM SRV1 alta", message: `RAM em ${m.memPercent.toFixed(1)}% (${(m.memUsedMb/1024).toFixed(1)}GB)` });
      }
      if (m.diskPercent > 85) {
        await this.alerts.dispatch({ ruleKey: "host_disk_high", severity: "warning", title: "Disco SRV1 cheio", message: `Disco em ${m.diskPercent.toFixed(1)}% (${m.diskUsedGb.toFixed(0)}/${m.diskTotalGb.toFixed(0)}GB)` });
      }
    } catch (err: any) {
      this.log.warn(`host metrics failed: ${err?.message}`);
    }
  }

  @Interval("container-metrics", 60_000)
  async containerMetricsTick() {
    try {
      const containers = await this.srv1.getContainers();
      const rows = containers.map(c => ({
        containerName: c.name,
        cpuPercent: c.cpuPercent,
        memMb: c.memMb,
        memPercent: c.memPercent
      }));
      if (rows.length) {
        await this.prisma.metricSnapshot.createMany({ data: rows });
      }
      this.gw.emitContainerMetrics({ containers, ts: Date.now() });

      // Detectar containers que sumiram desde último ciclo
      const nowRunning = new Set(containers.filter(c => c.state === "running" || c.status?.startsWith("Up")).map(c => c.name));
      if (this.lastSeenRunning.size > 0) {
        for (const name of this.lastSeenRunning) {
          if (!nowRunning.has(name)) {
            await this.timeline.log({
              eventType: "container_stopped",
              title: `Container parou: ${name}`,
              severity: "warning",
              actor: "scheduler"
            });
            await this.alerts.dispatch({
              ruleKey: `container_stopped_${name}`,
              severity: "warning",
              title: `Container parou`,
              message: `${name} estava rodando e agora parou`
            });
          }
        }
        // Detectar containers que voltaram
        for (const name of nowRunning) {
          if (!this.lastSeenRunning.has(name)) {
            await this.timeline.log({
              eventType: "container_started",
              title: `Container subiu: ${name}`,
              severity: "info",
              actor: "scheduler"
            });
          }
        }
      }
      this.lastSeenRunning = nowRunning;
    } catch (err: any) {
      this.log.warn(`container metrics failed: ${err?.message}`);
    }
  }

  @Interval("sites-check", 15 * 60_000)
  async sitesCheckTick() {
    try {
      const sites = await this.hestia.listSites();
      const down = sites.filter(s => !s.online);
      const sslExpiringSoon = sites.filter(s => {
        if (!s.sslExpiresAt) return false;
        const days = Math.ceil((new Date(s.sslExpiresAt).getTime() - Date.now()) / (24 * 3600_000));
        return days > 0 && days < 30;
      });
      if (down.length > 0) {
        await this.timeline.log({
          eventType: "sites_down",
          title: `${down.length} site(s) offline`,
          severity: "warning",
          detail: down.map(s => s.domain).join(", "),
          actor: "scheduler"
        });
      }
      if (sslExpiringSoon.length > 0) {
        await this.alerts.dispatch({
          ruleKey: "ssl_expiring",
          severity: "warning",
          title: "SSL expirando",
          message: sslExpiringSoon.map(s => s.domain).join(", ")
        });
      }
    } catch (err: any) {
      this.log.warn(`sites check failed: ${err?.message}`);
    }
  }

  @Interval("apis-ping", 30 * 60_000)
  async apisPingTick() {
    try {
      const results = await this.apis.pingAll();
      const down = results.filter((r: any) => r.status === "down");
      if (down.length > 0) {
        await this.timeline.log({
          eventType: "apis_down",
          title: `${down.length} API(s) com problema`,
          severity: "warning",
          detail: down.map((r: any) => r.name).join(", "),
          actor: "scheduler"
        });
      }
    } catch (err: any) {
      this.log.warn(`apis ping failed: ${err?.message}`);
    }
  }

  @Interval("coolify-deploys", 5 * 60_000)
  async coolifyDeploysTick() {
    try {
      const apps = await this.coolify.listApplications();
      if (!Array.isArray(apps)) return;
      for (const app of apps) {
        const uuid = app.uuid;
        const sha = app.git_commit_sha || "HEAD";
        const last = this.lastDeploySha.get(uuid);
        if (last && last !== sha) {
          // Novo deploy detectado
          await this.prisma.deployHistory.create({
            data: {
              project: app.name,
              coolifyUuid: uuid,
              status: app.status?.includes("healthy") ? "success" : "running",
              commitSha: sha,
              branch: app.git_branch || "main",
              triggeredBy: "coolify-detected",
              startedAt: new Date()
            }
          });
          await this.timeline.log({
            eventType: "deploy",
            title: `Deploy: ${app.name}`,
            severity: "info",
            project: app.name,
            detail: `${sha.slice(0, 7)} status=${app.status}`,
            actor: "coolify"
          });
        }
        this.lastDeploySha.set(uuid, sha);
      }
    } catch (err: any) {
      this.log.warn(`coolify deploys check failed: ${err?.message}`);
    }
  }

  @Cron("0 8 * * *", { timeZone: "America/Sao_Paulo" })
  async dailyDigest() {
    try {
      const containers = await this.srv1.getContainers().catch(() => []);
      const host = await this.srv1.getHostMetrics().catch(() => null);
      const apps = await this.coolify.listApplications().catch(() => []);
      const sites = await this.hestia.listSites().catch(() => []);
      const sitesOn = sites.filter((s: any) => s.online).length;
      const message = [
        `🌅 Bom dia João!`,
        ``,
        `📊 Resumo Controler NOC (${new Date().toLocaleDateString("pt-BR")})`,
        ``,
        `🖥 SRV1: CPU ${host?.cpuPercent?.toFixed(1)}% · RAM ${host?.memPercent?.toFixed(0)}% · Disco ${host?.diskPercent?.toFixed(0)}%`,
        `📦 Containers: ${containers.length} (${containers.filter(c => c.healthcheck === "healthy").length} healthy)`,
        `⚙ Apps Coolify: ${Array.isArray(apps) ? apps.length : 0}`,
        `🌐 Sites: ${sitesOn}/${sites.length} online`,
        ``,
        `https://noc.controler.net.br`
      ].join("\n");
      await this.alerts.dispatch({
        ruleKey: `daily-digest-${new Date().toISOString().slice(0, 10)}`,
        severity: "info",
        title: "Digest diário Controler",
        message,
        forceChannels: ["whatsapp"]
      });
      this.log.log(`Daily digest enviado`);
    } catch (err: any) {
      this.log.warn(`daily digest failed: ${err?.message}`);
    }
  }

  // limpeza diária: snapshots > 30 dias + timeline events > 90 dias
  // BD-01: + tabelas de auth (OTP expirado, sessions encerradas, audit logs antigos)
  @Cron("0 3 * * *", { timeZone: "America/Sao_Paulo" })
  async cleanup() {
    const now = new Date();
    const cutoffMetrics = new Date(Date.now() - 30 * 24 * 3600_000);
    const cutoffEvents = new Date(Date.now() - 90 * 24 * 3600_000);
    const cutoffSessions = new Date(Date.now() - 7 * 24 * 3600_000);
    const cutoffAudit = new Date(Date.now() - 180 * 24 * 3600_000);
    const [m, h, t, otp, sess, audit] = await Promise.all([
      this.prisma.metricSnapshot.deleteMany({ where: { createdAt: { lt: cutoffMetrics } } }),
      this.prisma.hostMetricSnapshot.deleteMany({ where: { createdAt: { lt: cutoffMetrics } } }),
      this.prisma.timelineEvent.deleteMany({ where: { createdAt: { lt: cutoffEvents } } }),
      // OTPs expirados ou já consumidos há mais de 24h
      this.prisma.otpToken.deleteMany({
        where: { OR: [{ expiresAt: { lt: now } }, { used: true, createdAt: { lt: new Date(Date.now() - 24 * 3600_000) } }] }
      }),
      // Sessions expiradas, ou encerradas (logout/revogadas/bloqueadas) há mais de 7 dias
      this.prisma.session.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { status: { in: ["logged_out", "revoked_by_new_login", "expired", "blocked"] }, updatedAt: { lt: cutoffSessions } }
          ]
        }
      }),
      // Audit log geral > 180 dias (VaultAuditLog é preservado integralmente)
      this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoffAudit } } })
    ]);
    this.log.log(
      `Cleanup: ${m.count + h.count} snapshots + ${t.count} events + ${otp.count} otps + ${sess.count} sessions + ${audit.count} audit logs removidos`
    );
  }

  /** Roda 1x na inicialização — popula timeline com snapshot inicial. */
  async onModuleInit() {
    try {
      await this.timeline.log({
        eventType: "system_boot",
        title: "Controler API iniciado",
        severity: "info",
        actor: "system",
        detail: `version=4.0.0 node=${process.version}`
      });
    } catch { /* ignore */ }
  }
}
