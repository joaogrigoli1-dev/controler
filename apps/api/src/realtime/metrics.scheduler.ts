/**
 * MetricsScheduler — jobs que rodam continuamente:
 *   - host-metrics:      RAW_INTERVAL_MS (60s)  snapshot + saturação PSI + disk IO + WS + alertas
 *   - container-metrics: RAW_INTERVAL_MS (60s)  registry + metric points + transições + alertas
 *   - systemd-units:     5min  transições failed↔active das units monitoradas
 *   - sites-check:       15min ping HTTP nos sites + atualiza Site.statusCode
 *   - apis-ping:         30min ping nas ProjectApi com healthUrl
 *   - daily-digest:      08:00 BRT  resumo via WhatsApp
 *   - cleanup:           03:00 BRT  purga com retenção por tabela
 *
 * FASE 3: a captura de deploys Coolify saiu daqui — migrou para o módulo
 * deploys (fonte melhor: API de deployments, não diff de commit SHA).
 */

import { Injectable, Logger } from "@nestjs/common";
import { Cron, Interval } from "@nestjs/schedule";
import { Prisma } from "@prisma/client";
import { Srv1Service } from "../srv1/srv1.service";
import { PrismaService } from "../common/prisma.service";
import { RealtimeGateway } from "./realtime.gateway";
import { TimelineService } from "../timeline/timeline.service";
import { AlertsService } from "../alerts/alerts.service";
import { HestiaService } from "../hestia/hestia.service";
import { ApisService } from "../apis/apis.service";
import { CoolifyService } from "../coolify/coolify.service";

/**
 * Cadência RAW dos ticks host/containers (FASE 3): 60s default — granularidade
 * suficiente p/ forense (incidente 06/2026: leak + thundering herd só ficou
 * visível em janelas curtas) sem saturar o host: a coleta é 1 sessão SSH por
 * tick, com guarda de sobreposição + circuit breaker 3×nproc segurando picos.
 * Escape hatch p/ produção: env NOC_RAW_INTERVAL_MS (ex.: 300000 = 5min antigos).
 */
export const RAW_INTERVAL_MS = parseInt(process.env.NOC_RAW_INTERVAL_MS || "60000", 10);

/**
 * Compat: consumido pelo analytics p/ cálculo de cobertura/uptime — precisa
 * seguir a cadência REAL do host tick, então espelha RAW_INTERVAL_MS.
 */
export const HOST_METRICS_INTERVAL_MS = RAW_INTERVAL_MS;

/** Units cuja falha é infra crítica (SSH/containers/segurança) → alerta critical. */
const SYSTEMD_CRITICAL_UNITS = new Set(["docker.service", "ssh.service", "fail2ban.service"]);

@Injectable()
export class MetricsScheduler {
  private readonly log = new Logger("Scheduler");
  // Track containers que estavam UP no último ciclo (detecta novos down)
  private lastSeenRunning = new Set<string>();
  // Guarda de sobreposição: impede um tick de empilhar sobre o anterior (host saturado)
  private running = new Set<string>();
  // Circuit breaker: último load1m observado; pula coleta pesada se host estiver em sobrecarga.
  // Limiar dinâmico = 3× nproc real (resolvido do host), não mais o hardcode 12 (4 vCPU).
  private lastLoad1m = 0;
  private loadCircuitBreak = 24; // default KVM8 (8 vCPU × 3); recalculado no 1º tick via getNproc()

  // ─── Estado em memória FASE 3 (derivadas entre ticks) ────
  /** Contador de ciclos do host tick — top-processes amostrado a cada 5 ciclos (~5min). */
  private hostCycle = 0;
  /** Violações PSI/swap consecutivas — alerta só com SUSTENTAÇÃO (evita blip de 1 ciclo). */
  private psiStreak = { cpu: 0, io: 0, mem: 0, swap: 0 };
  /** Último estado/health/restartCount/oomKilled por container → detecção de transições. */
  private prevContainer = new Map<string, { state: string; health: string; restartCount: number; oomKilled: boolean }>();
  /** Contadores acumulados net/blkio por container → taxa = Δ/Δt real (clamp ≥ 0: zera no restart). */
  private counterState = new Map<string, { ts: number; netRx: number; netTx: number; blkRead: number; blkWrite: number }>();
  /** Timestamps de restart por container (janela 24h) → crash-loop. */
  private restartWindow = new Map<string, number[]>();
  /** Timestamps de transição por container (janela 1h) → flapping. */
  private transitionWindow = new Map<string, number[]>();
  /** Ciclos consecutivos unhealthy por container. */
  private unhealthyStreak = new Map<string, number>();
  /** activeState anterior por unit systemd → eventos failed↔active. */
  private prevUnitState = new Map<string, string>();

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

  @Interval("host-metrics", RAW_INTERVAL_MS)
  async hostMetricsTick() {
    if (this.running.has("host")) { this.log.warn("host tick ainda rodando; pulando"); return; }
    this.running.add("host");
    try {
      // Saturação e disk IO coletados no MESMO ciclo do snapshot (1 linha/tick nas tabelas)
      const [m, sat, diskio] = await Promise.all([
        this.srv1.getHostMetrics(),
        this.srv1.getSaturation().catch(() => null),
        this.srv1.getDiskIo().catch(() => null)
      ]);
      this.lastLoad1m = m.loadAvg?.[0] ?? this.lastLoad1m;
      // Recalcula o limiar do breaker com o nº de vCPUs real (3× nproc)
      try { this.loadCircuitBreak = 3 * (await this.srv1.getNproc()); } catch { /* mantém default */ }

      await this.prisma.hostMetricSnapshot.create({
        data: {
          cpuPercent: m.cpuPercent,
          loadAvg1m: m.loadAvg[0], loadAvg5m: m.loadAvg[1], loadAvg15m: m.loadAvg[2],
          memTotalMb: m.memTotalMb, memUsedMb: m.memUsedMb,
          diskTotalGb: m.diskTotalGb, diskUsedGb: m.diskUsedGb,
          swapUsedMb: m.swapUsedMb,
          netInBytes: BigInt(m.netInBytes || 0), netOutBytes: BigInt(m.netOutBytes || 0),
          // FASE 3: swap detalhado + PSI (Pressure Stall Information)
          swapTotalMb: sat?.swap?.totalMb ?? null,
          swapInPagesSec: sat?.swap?.inPagesSec ?? null,
          swapOutPagesSec: sat?.swap?.outPagesSec ?? null,
          psiCpuSomeAvg10: sat?.psi.cpu.some.avg10 ?? null,
          psiCpuSomeAvg60: sat?.psi.cpu.some.avg60 ?? null,
          psiCpuSomeAvg300: sat?.psi.cpu.some.avg300 ?? null,
          psiIoSomeAvg10: sat?.psi.io.some.avg10 ?? null,
          psiIoSomeAvg60: sat?.psi.io.some.avg60 ?? null,
          psiIoFullAvg10: sat?.psi.io.full?.avg10 ?? null,
          psiIoFullAvg60: sat?.psi.io.full?.avg60 ?? null,
          psiMemSomeAvg10: sat?.psi.memory.some.avg10 ?? null,
          psiMemSomeAvg60: sat?.psi.memory.some.avg60 ?? null,
          psiMemFullAvg10: sat?.psi.memory.full?.avg10 ?? null,
          psiMemFullAvg60: sat?.psi.memory.full?.avg60 ?? null
        }
      });

      // 1 linha por device físico (loop/ram já filtrados no coletor)
      if (diskio?.devices?.length) {
        await this.prisma.hostDiskIoPoint.createMany({
          data: diskio.devices.map(d => ({
            device: d.device,
            utilPercent: d.utilPercent,
            readAwaitMs: d.readAwaitMs, writeAwaitMs: d.writeAwaitMs,
            readIops: d.readIops, writeIops: d.writeIops,
            readKbps: d.readKbps, writeKbps: d.writeKbps,
            avgQueueSize: d.avgQueueSize
          }))
        });
      }

      // Top-10 processos por CPU a cada 5 ciclos (~5min) — forense de leak (incidente 06/2026)
      this.hostCycle++;
      if (this.hostCycle % 5 === 0) {
        try {
          const top = await this.srv1.getTopProcesses("cpu", 10);
          if (top.length) {
            await this.prisma.hostProcessSample.createMany({
              data: top.map((p, i) => ({
                rank: i + 1,
                pid: p.pid,
                command: p.command,
                cpuPercent: p.cpu,
                // ps reporta %mem — converte p/ MB com o memTotal real do host
                memMb: +(((p.mem || 0) / 100) * m.memTotalMb).toFixed(1)
              }))
            });
          }
        } catch (e: any) { this.log.warn(`top processes sample failed: ${e?.message}`); }
      }

      // WS: payload legado + saturação (gauges PSI em tempo real no front)
      this.gw.emitHostMetrics({ ...m, saturation: sat, ts: Date.now() });

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

      // FASE 3: alertas PSI/swap com SUSTENTAÇÃO (n ciclos consecutivos).
      // E4: operadores >= em todos os streaks (consistência CPU >= 2 / swap >= 5);
      // === deixava evento sustentado sem disparo se o contador pulasse o valor exato.
      if (sat) {
        this.psiStreak.cpu = sat.psi.cpu.some.avg60 > 25 ? this.psiStreak.cpu + 1 : 0;
        this.psiStreak.io = (sat.psi.io.full?.avg10 ?? 0) > 25 ? this.psiStreak.io + 1 : 0;
        this.psiStreak.mem = (sat.psi.memory.full?.avg10 ?? 0) > 5 ? this.psiStreak.mem + 1 : 0;
        this.psiStreak.swap = (sat.swap?.outPagesSec ?? 0) > 0 ? this.psiStreak.swap + 1 : 0;
        if (this.psiStreak.cpu >= 2) {
          await this.alerts.dispatch({ ruleKey: "host_psi_cpu", severity: "warning", title: "Pressão de CPU sustentada (PSI)", message: `psi cpu some avg60=${sat.psi.cpu.some.avg60.toFixed(1)} > 25 há ${this.psiStreak.cpu} ciclos` });
        }
        if (this.psiStreak.io >= 2) {
          await this.alerts.dispatch({ ruleKey: "host_psi_io", severity: "critical", title: "Pressão de IO crítica (PSI full)", message: `psi io full avg10=${(sat.psi.io.full?.avg10 ?? 0).toFixed(1)} > 25 por 2 ciclos — disco travando processos` });
        }
        if (this.psiStreak.mem >= 2) {
          await this.alerts.dispatch({ ruleKey: "host_psi_mem", severity: "critical", title: "Pressão de memória crítica (PSI full)", message: `psi mem full avg10=${(sat.psi.memory.full?.avg10 ?? 0).toFixed(1)} > 5 por 2 ciclos — risco de OOM iminente` });
        }
        if (this.psiStreak.swap >= 5) {
          await this.alerts.dispatch({ ruleKey: "host_swap_thrash", severity: "warning", title: "Swap thrashing", message: `swap-out ${(sat.swap?.outPagesSec ?? 0).toFixed(1)} págs/s sustentado há ${this.psiStreak.swap} ciclos` });
        }
      }

      // E1c: motor de AlertRules do banco — avalia regras habilitadas contra as
      // métricas deste tick (cooldown/silencedUntil tratados no AlertsService)
      try {
        await this.alerts.evaluateRules({
          cpuPercent: m.cpuPercent,
          memPercent: m.memPercent,
          diskPercent: m.diskPercent,
          load1m: m.loadAvg?.[0],
          psiCpuSomeAvg60: sat?.psi.cpu.some.avg60,
          psiIoSomeAvg60: sat?.psi.io.some.avg60,
          psiIoFullAvg60: sat?.psi.io.full?.avg60,
          psiMemSomeAvg60: sat?.psi.memory.some.avg60
        });
      } catch (e: any) {
        this.log.warn(`evaluateRules failed: ${e?.message}`);
      }
    } catch (err: any) {
      this.log.warn(`host metrics failed: ${err?.message}`);
    } finally {
      this.running.delete("host");
    }
  }

  @Interval("container-metrics", RAW_INTERVAL_MS)
  async containerMetricsTick() {
    if (this.running.has("containers")) { this.log.warn("container tick ainda rodando; pulando"); return; }
    // Circuit breaker: host em sobrecarga → não dispara o docker stats pesado em todos os containers
    if (this.lastLoad1m > this.loadCircuitBreak) {
      this.log.warn(`load ${this.lastLoad1m.toFixed(1)} > ${this.loadCircuitBreak} (3×nproc); pulando container-metrics`);
      return;
    }
    this.running.add("containers");
    try {
      const containers = await this.srv1.getContainersDetailed();
      const now = Date.now();

      // Legado: MetricSnapshot continua sendo gravado (compat /analytics atual)
      const legacyRows = containers.map(c => ({
        containerName: c.name,
        cpuPercent: c.cpuPercent,
        memMb: c.memMb,
        memPercent: c.memPercent
      }));
      if (legacyRows.length) {
        await this.prisma.metricSnapshot.createMany({ data: legacyRows });
      }
      this.gw.emitContainerMetrics({ containers, ts: now });

      const points: Prisma.ContainerMetricPointCreateManyInput[] = [];
      const seen = new Set<string>();
      for (const c of containers) {
        seen.add(c.name);

        // Registry: upsert por nome (Container.name unique)
        const reg = await this.prisma.container.upsert({
          where: { name: c.name },
          create: {
            name: c.name, image: c.image, currentHealth: c.health,
            restartCount: c.restartCount,
            startedAt: c.startedAt ? new Date(c.startedAt) : null
          },
          update: {
            image: c.image, currentHealth: c.health, restartCount: c.restartCount,
            startedAt: c.startedAt ? new Date(c.startedAt) : null,
            lastSeenAt: new Date()
          }
        });

        // Taxas net/blkio = Δcontador/Δt REAL entre ticks (contador zera no restart → clamp ≥ 0)
        const prevCnt = this.counterState.get(c.name);
        let netRxKbps: number | null = null, netTxKbps: number | null = null;
        let blkioReadKbps: number | null = null, blkioWriteKbps: number | null = null;
        if (prevCnt && now > prevCnt.ts) {
          const dtSec = (now - prevCnt.ts) / 1000;
          const rate = (cur: number, prev: number) => +(Math.max(0, cur - prev) / 1024 / dtSec).toFixed(2);
          netRxKbps = rate(c.netRxBytes, prevCnt.netRx);
          netTxKbps = rate(c.netTxBytes, prevCnt.netTx);
          blkioReadKbps = rate(c.blkioReadBytes, prevCnt.blkRead);
          blkioWriteKbps = rate(c.blkioWriteBytes, prevCnt.blkWrite);
        }
        this.counterState.set(c.name, {
          ts: now, netRx: c.netRxBytes, netTx: c.netTxBytes,
          blkRead: c.blkioReadBytes, blkWrite: c.blkioWriteBytes
        });

        const uptimeSec = c.state === "running" && c.startedAt
          ? Math.max(0, Math.floor((now - Date.parse(c.startedAt)) / 1000))
          : null;
        points.push({
          containerId: reg.id,
          cpuPercent: c.cpuPercent,
          memUsedMb: c.memMb,
          memLimitMb: c.memLimitMb,
          memPercent: c.memPercent,
          netRxKbps, netTxKbps, blkioReadKbps, blkioWriteKbps,
          pids: c.pids,
          restartCount: c.restartCount,
          health: c.health,
          uptimeSec
        });

        // ── Transições de estado/health/restart → ContainerStateEvent ──
        const prev = this.prevContainer.get(c.name);
        if (prev) {
          const stateChanged = prev.state !== c.state;
          const healthChanged = prev.health !== c.health;
          const dRestarts = Math.max(0, c.restartCount - prev.restartCount);
          if (stateChanged || healthChanged || dRestarts > 0) {
            const reasonParts: string[] = [];
            if (healthChanged) reasonParts.push(`health ${prev.health}→${c.health}`);
            if (dRestarts > 0) reasonParts.push(`restarts +${dRestarts} (${prev.restartCount}→${c.restartCount})`);
            await this.prisma.containerStateEvent.create({
              data: {
                containerId: reg.id,
                fromState: prev.state,
                toState: c.state,
                exitCode: c.exitCode,
                oomKilled: c.oomKilled,
                reason: reasonParts.length ? reasonParts.join("; ") : null
              }
            });
            // Flapping: ≥3 transições na janela de 1h (memória)
            const tw = (this.transitionWindow.get(c.name) || []).filter(t => now - t < 3600_000);
            tw.push(now);
            this.transitionWindow.set(c.name, tw);
            if (tw.length >= 3) {
              await this.alerts.dispatch({ ruleKey: `flapping_${c.name}`, severity: "warning", title: "Container flapping", message: `${c.name}: ${tw.length} transições de estado na última hora` });
            }
          }
          // OOMKill: CRITICAL imediato na TRANSIÇÃO false→true (histórico do incidente 06/2026)
          if (c.oomKilled && !prev.oomKilled) {
            await this.alerts.dispatch({ ruleKey: `oom_${c.name}`, severity: "critical", title: "Container OOMKilled", message: `${c.name} foi morto pelo kernel por falta de memória (exitCode=${c.exitCode})` });
          }
          // Crash-loop: >3 restarts na janela de 24h (memória)
          if (dRestarts > 0) {
            const rw = (this.restartWindow.get(c.name) || []).filter(t => now - t < 24 * 3600_000);
            for (let i = 0; i < dRestarts; i++) rw.push(now);
            this.restartWindow.set(c.name, rw);
            if (rw.length > 3) {
              await this.alerts.dispatch({ ruleKey: `crash_loop_${c.name}`, severity: "warning", title: "Container em crash-loop", message: `${c.name}: ${rw.length} restarts nas últimas 24h` });
            }
          }
        }
        // Health unhealthy sustentado 2 ciclos → critical (dispara 1x ao cruzar — critical fura cooldown)
        const streak = c.health === "unhealthy" ? (this.unhealthyStreak.get(c.name) || 0) + 1 : 0;
        this.unhealthyStreak.set(c.name, streak);
        if (streak === 2) {
          await this.alerts.dispatch({ ruleKey: `unhealthy_${c.name}`, severity: "critical", title: "Container unhealthy sustentado", message: `${c.name} está unhealthy há 2 ciclos consecutivos` });
        }

        this.prevContainer.set(c.name, { state: c.state, health: c.health, restartCount: c.restartCount, oomKilled: c.oomKilled });
      }
      if (points.length) {
        await this.prisma.containerMetricPoint.createMany({ data: points });
      }

      // Higiene: descarta estado em memória de containers removidos do host
      for (const name of [...this.counterState.keys()]) {
        if (!seen.has(name)) {
          this.counterState.delete(name);
          this.prevContainer.delete(name);
          this.unhealthyStreak.delete(name);
          this.restartWindow.delete(name);
          this.transitionWindow.delete(name);
        }
      }

      // Detectar containers que sumiram desde último ciclo (mantido da fase anterior)
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
    } finally {
      this.running.delete("containers");
    }
  }

  // FASE 3: transições de units systemd (failed ↔ recuperada) a cada 5min
  @Interval("systemd-units", 5 * 60_000)
  async systemdUnitsTick() {
    if (this.running.has("systemd")) return;
    this.running.add("systemd");
    try {
      const services = await this.srv1.getServices();
      for (const s of services) {
        const prev = this.prevUnitState.get(s.name);
        if (s.activeState === "failed" && prev !== "failed") {
          // Unit entrou em failed AGORA (não estava failed no ciclo anterior)
          await this.prisma.systemdUnitEvent.create({
            data: {
              unitName: s.name,
              activeState: s.activeState,
              subState: s.subState,
              fromState: prev ?? null,
              message: `unit entrou em failed (${s.subState})`
            }
          });
          const critical = SYSTEMD_CRITICAL_UNITS.has(s.name);
          await this.alerts.dispatch({
            ruleKey: `systemd_failed_${s.name}`,
            severity: critical ? "critical" : "warning",
            title: `Unit systemd failed: ${s.name}`,
            message: `${s.name} entrou em estado failed (${s.subState})${critical ? " — unit crítica de infra" : ""}`
          });
        } else if (prev === "failed" && s.activeState !== "failed") {
          // Recuperação failed→active (ou outro estado não-failed)
          await this.prisma.systemdUnitEvent.create({
            data: {
              unitName: s.name,
              activeState: s.activeState,
              subState: s.subState,
              fromState: "failed",
              message: "unit recuperada"
            }
          });
        }
        this.prevUnitState.set(s.name, s.activeState);
      }
    } catch (err: any) {
      this.log.warn(`systemd units check failed: ${err?.message}`);
    } finally {
      this.running.delete("systemd");
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
  // FASE 3: + retenção do plano p/ as tabelas gravadas AQUI (rollups são do RollupService):
  //   containerMetricPoint/hostDiskIoPoint > 10d · hostProcessSample > 7d ·
  //   containerStateEvent/systemdUnitEvent > 180d
  @Cron("0 3 * * *", { timeZone: "America/Sao_Paulo" })
  async cleanup() {
    const now = new Date();
    const cutoffMetrics = new Date(Date.now() - 30 * 24 * 3600_000);
    const cutoffEvents = new Date(Date.now() - 90 * 24 * 3600_000);
    const cutoffSessions = new Date(Date.now() - 7 * 24 * 3600_000);
    const cutoffAudit = new Date(Date.now() - 180 * 24 * 3600_000);
    const cutoffRaw10d = new Date(Date.now() - 10 * 24 * 3600_000);
    const cutoffProc7d = new Date(Date.now() - 7 * 24 * 3600_000);
    const [m, h, t, otp, sess, audit, cmp, dio, proc, cse, sue] = await Promise.all([
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
      this.prisma.auditLog.deleteMany({ where: { createdAt: { lt: cutoffAudit } } }),
      // FASE 3 — retenção das séries raw + eventos coletados por este scheduler
      this.prisma.containerMetricPoint.deleteMany({ where: { ts: { lt: cutoffRaw10d } } }),
      this.prisma.hostDiskIoPoint.deleteMany({ where: { ts: { lt: cutoffRaw10d } } }),
      this.prisma.hostProcessSample.deleteMany({ where: { ts: { lt: cutoffProc7d } } }),
      this.prisma.containerStateEvent.deleteMany({ where: { ts: { lt: cutoffAudit } } }),
      this.prisma.systemdUnitEvent.deleteMany({ where: { ts: { lt: cutoffAudit } } })
    ]);
    this.log.log(
      `Cleanup: ${m.count + h.count} snapshots + ${t.count} events + ${otp.count} otps + ${sess.count} sessions + ${audit.count} audit logs + ` +
      `${cmp.count} container points + ${dio.count} diskio points + ${proc.count} process samples + ${cse.count + sue.count} state events removidos`
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
