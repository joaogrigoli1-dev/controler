/**
 * Srv1Service — agrega métricas do SRV1 via Hostinger API + SSH + Docker.
 * Cache Redis: 30s host; 15s containers/saturação/diskio/rede; 60s systemd.
 */

import { Injectable, Logger } from "@nestjs/common";
import { HostingerService } from "../common/hostinger.service";
import { SshService } from "../common/ssh.service";
import { RedisService } from "../common/redis.service";
import type { HostMetrics, ContainerSummary } from "../shared";

// ─── Tipos FASE 3 — contrato do frontend (apps/web/lib/schemas.ts) ───────
// Campos e nomes espelham HostSaturationSchema/HostDiskIoSchema/HostNetworkSchema.
// Convenção de unidade: "Kbps" = kB/s (mesma unidade do rkB/s do iostat).

/** Linha `some`/`full` de /proc/pressure/{cpu,io,memory}. */
export interface PsiLine { avg10: number; avg60: number; avg300: number | null }
export interface PsiResource { some: PsiLine; full: PsiLine | null }
export interface HostSaturation {
  ts: string;
  psi: { cpu: PsiResource; io: PsiResource; memory: PsiResource };
  swap: { totalMb: number; usedMb: number; inPagesSec: number | null; outPagesSec: number | null };
  nproc: number;
  loadPerCore: number;
}

export interface DiskIoDevice {
  device: string;
  utilPercent: number;
  readAwaitMs: number | null;
  writeAwaitMs: number | null;
  readIops: number | null;
  writeIops: number | null;
  readKbps: number | null;
  writeKbps: number | null;
  avgQueueSize: number | null;
}
export interface HostDiskIo { ts: string; devices: DiskIoDevice[] }

export interface NetIfaceRate {
  iface: string;
  rxKbps: number;
  txKbps: number;
  rxErrors: number;
  txErrors: number;
  rxDrops: number;
  txDrops: number;
}
export interface HostNetwork { ts: string; ifaces: NetIfaceRate[]; tcpRetransPercent: number | null }

/** Espelha o enum ContainerHealth do Prisma — atribuível direto ao client. */
export type ContainerHealthState = "healthy" | "unhealthy" | "starting" | "none" | "exited";

/** Superset de ContainerSummary — o endpoint /srv1/containers segue válido (extras tolerados). */
export interface ContainerDetailed extends ContainerSummary {
  health: ContainerHealthState;
  memLimitMb: number | null;
  /** Contadores ACUMULADOS do docker stats (NET I/O / BLOCK I/O) — taxa é derivada no scheduler. */
  netRxBytes: number;
  netTxBytes: number;
  blkioReadBytes: number;
  blkioWriteBytes: number;
  pids: number | null;
  restartCount: number;
  startedAt: string | null;
  oomKilled: boolean;
  exitCode: number | null;
}

const SYSTEMD_TARGETS = [
  "docker.service",
  "containerd.service",
  "ssh.service",
  "fail2ban.service",
  "clamav-daemon.service",
  "postgresql@16-main.service",
  "ollama.service",
  "pm2-root.service",
  "cron.service",
  "unattended-upgrades.service"
];

@Injectable()
export class Srv1Service {
  private readonly log = new Logger("SRV1");
  /** nº de vCPUs real do host, detectado via SSH (`nproc`) e cacheado. Fase 2: fim do hardcode 4. */
  private nproc: number | null = null;

  constructor(
    private readonly hostinger: HostingerService,
    private readonly ssh: SshService,
    private readonly redis: RedisService
  ) {}

  /** Detecta e cacheia o nº de vCPUs (nproc). Fallback 8 (KVM8 atual) se SSH falhar. */
  async getNproc(): Promise<number> {
    if (this.nproc && this.nproc > 0) return this.nproc;
    try {
      const r = await this.ssh.srv1("nproc", 5_000);
      const n = parseInt((r.stdout || "").trim(), 10);
      if (n > 0) { this.nproc = n; return n; }
    } catch { /* fallback abaixo */ }
    return this.nproc ?? 8;
  }

  // ─── Host metrics (combinando Hostinger API + SSH ad-hoc) ─────
  async getHostMetrics(): Promise<HostMetrics> {
    return this.redis.cached("srv1:host-metrics", 30, async () => {
      const [metrics, sshSnap, nproc] = await Promise.all([
        this.hostinger.getMetrics(HostingerService.SRV1, 1).catch(() => null),
        // 2 amostras de /proc/stat (sleep 1) → CPU% real por delta de idle (não mais load/4)
        this.ssh.srv1(
          "cat /proc/loadavg && free -b && df -B1 / && cat /proc/uptime && " +
          "echo '---CPU---' && grep '^cpu ' /proc/stat && sleep 1 && grep '^cpu ' /proc/stat",
          8_000
        ).catch(() => null),
        this.getNproc().catch(() => 8)
      ]);

      // CPU/disk/memory de Hostinger (último ponto)
      const lastVal = (s: any) => {
        if (!s?.usage) return null;
        const keys = Object.keys(s.usage).sort();
        return s.usage[keys[keys.length - 1]];
      };

      // Hostinger é fonte preferida, mas pode retornar 0 quando dados frescos não existem
      // (típico pós-reboot ou primeiros 5-10min). SSH preenche o que faltar.
      let cpuPercent = metrics ? (lastVal(metrics.cpu_usage) ?? 0) : 0;
      let memUsedBytes = metrics ? (lastVal(metrics.ram_usage) ?? 0) : 0;
      let diskUsedBytes = metrics ? (lastVal(metrics.disk_space) ?? 0) : 0;
      const netIn = metrics ? (lastVal(metrics.incoming_traffic) ?? 0) : 0;
      const netOut = metrics ? (lastVal(metrics.outgoing_traffic) ?? 0) : 0;
      let uptimeSeconds = metrics ? (lastVal(metrics.uptime) ?? 0) : 0;

      // loadavg + free + df via SSH (defaults se falhar)
      let loadAvg: [number, number, number] = [0, 0, 0];
      // Defaults de fallback alinhados ao hardware REAL (KVM8: 32 GB / 400 GB) — antes 16/200 (KVM4)
      let memTotalBytes = 32 * 1024 ** 3;
      let memFreeBytes = 0;
      let diskTotalBytes = 400 * 1024 ** 3;
      let diskUsedSshBytes = 0;
      let swapUsedBytes = 0;
      let uptimeSshSeconds = 0;
      if (sshSnap?.stdout) {
        const full = sshSnap.stdout;
        const [sysBlock, cpuBlock] = full.split("---CPU---");
        const lines = (sysBlock || "").split("\n");
        // /proc/loadavg → "0.96 1.50 1.80 1/666 12345"
        const loadParts = (lines[0] || "").split(/\s+/);
        loadAvg = [parseFloat(loadParts[0] || "0"), parseFloat(loadParts[1] || "0"), parseFloat(loadParts[2] || "0")];
        // free -b → "Mem: total used free shared buff/cache available"
        const memLine = lines.find(l => l.startsWith("Mem:")) || "";
        const memParts = memLine.split(/\s+/);
        memTotalBytes = parseInt(memParts[1] || "0", 10) || memTotalBytes;
        // Fase 2: usar 'available' (col 7) — 'used' (col 3) infla com buff/cache e gera falso alerta
        const memAvailableSsh = parseInt(memParts[6] || "0", 10) || 0;
        memFreeBytes = parseInt(memParts[3] || "0", 10) || 0;
        const memUsedSsh = memAvailableSsh && memTotalBytes ? memTotalBytes - memAvailableSsh
          : (parseInt(memParts[2] || "0", 10) || 0);
        const swapLine = lines.find(l => l.startsWith("Swap:")) || "";
        const swapParts = swapLine.split(/\s+/);
        swapUsedBytes = parseInt(swapParts[2] || "0", 10) || 0;
        // df -B1 / → device-agnóstico: pega a linha de dados cujo mountpoint é "/"
        // (sda1/vda1/nvme0n1p1/overlay — antes só casava /dev/sd*, quebrando em virtio/nvme)
        const dfLine = lines.find(l => /\s\/$/.test(l) && /^\S+\s+\d/.test(l)) || "";
        const dfParts = dfLine.split(/\s+/);
        diskTotalBytes = parseInt(dfParts[1] || "0", 10) || diskTotalBytes;
        diskUsedSshBytes = parseInt(dfParts[2] || "0", 10) || 0;
        // /proc/uptime → "12345.67 4567.89" (EXATAMENTE 2 floats até o fim da linha).
        // Ancorar em $ evita casar a linha do loadavg "0.96 1.50 1.80 1/666 12345".
        const uptimeLine = lines.find(l => /^\d+\.\d+ \d+\.\d+\s*$/.test(l)) || "";
        uptimeSshSeconds = Math.floor(parseFloat(uptimeLine.split(/\s+/)[0] || "0")) || 0;

        // CPU% REAL via delta de /proc/stat (2 amostras). iowait NÃO conta como busy;
        // steal conta (contenção do hypervisor aparece como uso). Substitui o proxy load/4.
        const cpuFromStat = parseCpuDelta(cpuBlock || "");
        if (cpuFromStat !== null) cpuPercent = cpuFromStat;

        // FALLBACK: se Hostinger retornou 0, usa SSH
        if (!memUsedBytes && memUsedSsh) memUsedBytes = memUsedSsh;
        if (!diskUsedBytes && diskUsedSshBytes) diskUsedBytes = diskUsedSshBytes;
        if (!uptimeSeconds && uptimeSshSeconds) uptimeSeconds = uptimeSshSeconds;
        // Último recurso: se nem /proc/stat nem Hostinger deram CPU, proxy load/nproc (nproc real)
        if (!cpuPercent && loadAvg[0]) {
          cpuPercent = Math.min(100, (loadAvg[0] / (nproc || 8)) * 100);
        }
      }
      const toMb = (b: number) => Math.round(b / 1024 / 1024);
      const toGb = (b: number) => +(b / 1024 / 1024 / 1024).toFixed(2);

      return {
        cpuPercent: +cpuPercent.toFixed(2),
        loadAvg,
        memTotalMb: toMb(memTotalBytes),
        memUsedMb: toMb(memUsedBytes),
        memPercent: memTotalBytes ? +((memUsedBytes / memTotalBytes) * 100).toFixed(2) : 0,
        diskTotalGb: toGb(diskTotalBytes),
        diskUsedGb: toGb(diskUsedBytes),
        diskPercent: diskTotalBytes ? +((diskUsedBytes / diskTotalBytes) * 100).toFixed(2) : 0,
        swapUsedMb: toMb(swapUsedBytes),
        uptimeSeconds,
        netInBytes: netIn,
        netOutBytes: netOut
      };
    });
  }

  // ─── Containers via docker ps + stats + inspect (FASE 3) ─
  /**
   * Coleta detalhada em UMA sessão SSH: docker ps -a (estado) + docker stats
   * (cpu/mem/net/blkio/pids) + docker inspect em lote (restartCount/health/
   * startedAt/oomKilled/exitCode). getContainers() delega para cá — o shape
   * público de /srv1/containers vira um SUPERSET (ContainerListSchema do
   * frontend tolera campos extras).
   */
  async getContainersDetailed(): Promise<ContainerDetailed[]> {
    return this.redis.cached("srv1:containers-detailed", 15, async () => {
      const result = await this.ssh.srv1(
        `docker ps -a --format '{{json .}}'; echo '---STATS---'; docker stats --no-stream --format '{{json .}}'; ` +
        // {{if .State.Health}} evita erro de template em containers sem healthcheck
        `echo '---INSPECT---'; docker inspect --format '{{.Name}}|{{.RestartCount}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.State.StartedAt}}|{{.State.OOMKilled}}|{{.State.ExitCode}}' $(docker ps -aq) 2>/dev/null`,
        30_000
      );
      const out = result.stdout || "";
      const [psBlock, rest] = out.split("---STATS---");
      const [statsBlock, inspectBlock] = (rest || "").split("---INSPECT---");
      const ps = parseJsonLines(psBlock);
      const stats = parseJsonLines(statsBlock);
      const statByName: Record<string, any> = {};
      stats.forEach(s => { statByName[s.Name] = s; });

      // inspect em lote: 1 linha por container "nome|restarts|health|startedAt|oom|exitCode"
      const inspectByName: Record<string, {
        restartCount: number; health: string; startedAt: string | null; oomKilled: boolean; exitCode: number;
      }> = {};
      (inspectBlock || "").trim().split("\n").filter(Boolean).forEach(l => {
        const parts = l.split("|");
        if (parts.length < 6) return; // linha corrompida — tolera
        const name = (parts[0] || "").replace(/^\//, "");
        const startedRaw = parts[3] || "";
        inspectByName[name] = {
          restartCount: parseInt(parts[1] || "0", 10) || 0,
          health: parts[2] || "none",
          // "0001-01-01T..." = container nunca iniciou
          startedAt: startedRaw.startsWith("0001-") ? null : startedRaw || null,
          oomKilled: parts[4] === "true",
          exitCode: parseInt(parts[5] || "0", 10) || 0
        };
      });

      return ps.map(c => {
        const s = statByName[c.Names];
        const insp = inspectByName[c.Names];
        const cpu = s?.CPUPerc ? parseFloat(s.CPUPerc.replace("%", "")) || 0 : 0;
        const memPerc = s?.MemPerc ? parseFloat(s.MemPerc.replace("%", "")) || 0 : 0;
        // MemUsage "515.4MiB / 31.34GiB" → uso + limite
        const [memUsageRaw, memLimitRaw] = String(s?.MemUsage || "").split("/").map(x => x.trim());
        const memMb = parseMemToMb(memUsageRaw || "0MiB");
        const memLimitMb = memLimitRaw ? parseMemToMb(memLimitRaw) : null;
        // NET I/O / BLOCK I/O "1.2MB / 3.4GB" → contadores acumulados em bytes
        const [netRxRaw, netTxRaw] = String(s?.NetIO || "").split("/").map(x => x.trim());
        const [blkReadRaw, blkWriteRaw] = String(s?.BlockIO || "").split("/").map(x => x.trim());
        const status: string = c.Status || "";
        const state: string = c.State || (status.startsWith("Up") ? "running" : "exited");
        // health: inspect é a fonte primária; sufixo do Status é fallback; exited quando parado
        let health: ContainerHealthState = "none";
        const ih = insp?.health;
        if (ih === "healthy" || ih === "unhealthy" || ih === "starting") health = ih;
        else if (status.includes("(healthy)")) health = "healthy";
        else if (status.includes("(unhealthy)")) health = "unhealthy";
        else if (status.includes("(starting)") || status.includes("(health: starting)")) health = "starting";
        if (health === "none" && state !== "running") health = "exited";
        // Campo legado healthcheck mantém o domínio antigo de 4 valores
        const hc: ContainerSummary["healthcheck"] = health === "exited" ? "none" : health;
        return {
          name: c.Names,
          image: c.Image,
          status,
          state,
          cpuPercent: cpu,
          memMb,
          memPercent: memPerc,
          uptime: status.replace(/^Up\s+/, "").split(" (")[0],
          healthcheck: hc,
          ports: c.Ports ? c.Ports.split(", ") : [],
          health,
          memLimitMb,
          netRxBytes: parseDockerBytes(netRxRaw),
          netTxBytes: parseDockerBytes(netTxRaw),
          blkioReadBytes: parseDockerBytes(blkReadRaw),
          blkioWriteBytes: parseDockerBytes(blkWriteRaw),
          pids: s?.PIDs != null ? parseInt(String(s.PIDs), 10) || 0 : null,
          restartCount: insp?.restartCount ?? 0,
          startedAt: insp?.startedAt ?? null,
          oomKilled: insp?.oomKilled ?? false,
          exitCode: insp?.exitCode ?? null
        };
      });
    });
  }

  /** Shape legado de /srv1/containers — hoje um subset da coleta detalhada (1 coleta só). */
  async getContainers(): Promise<ContainerSummary[]> {
    return this.getContainersDetailed();
  }

  // ─── Saturação: PSI + swap + load/core (FASE 3) ──────────
  /**
   * PSI (/proc/pressure/*), swap (meminfo + vmstat) e load por core em UMA
   * sessão SSH. Tolerante a falha de parse: bloco ausente vira zeros/null.
   */
  async getSaturation(): Promise<HostSaturation> {
    return this.redis.cached("srv1:saturation", 15, async () => {
      const [r, nproc] = await Promise.all([
        this.ssh.srv1(
          "cat /proc/pressure/cpu 2>/dev/null; echo '---IO---'; cat /proc/pressure/io 2>/dev/null; " +
          "echo '---MEM---'; cat /proc/pressure/memory 2>/dev/null; " +
          "echo '---MEMINFO---'; grep -E '^Swap(Total|Free):' /proc/meminfo; " +
          "echo '---LOAD---'; cat /proc/loadavg; " +
          // vmstat 1 2: a 2ª (última) linha é o delta real de 1s — si/so em páginas/s
          "echo '---VMSTAT---'; vmstat 1 2 2>/dev/null",
          15_000
        ).catch(() => null),
        this.getNproc().catch(() => 8)
      ]);
      const out = r?.stdout || "";
      const [cpuBlk, rest1] = out.split("---IO---");
      const [ioBlk, rest2] = (rest1 || "").split("---MEM---");
      const [memBlk, rest3] = (rest2 || "").split("---MEMINFO---");
      const [memInfoBlk, rest4] = (rest3 || "").split("---LOAD---");
      const [loadBlk, vmstatBlk] = (rest4 || "").split("---VMSTAT---");

      const swapTotalKb = parseInt((memInfoBlk || "").match(/SwapTotal:\s+(\d+)/)?.[1] || "0", 10);
      const swapFreeKb = parseInt((memInfoBlk || "").match(/SwapFree:\s+(\d+)/)?.[1] || "0", 10);
      const { si, so } = parseVmstatSwap(vmstatBlk || "");
      const load1m = parseFloat((loadBlk || "").trim().split(/\s+/)[0] || "0") || 0;

      return {
        ts: new Date().toISOString(),
        psi: {
          cpu: parsePsiBlock(cpuBlk || ""),
          io: parsePsiBlock(ioBlk || ""),
          memory: parsePsiBlock(memBlk || "")
        },
        swap: {
          totalMb: +(swapTotalKb / 1024).toFixed(1),
          usedMb: +(Math.max(0, swapTotalKb - swapFreeKb) / 1024).toFixed(1),
          inPagesSec: si,
          outPagesSec: so
        },
        nproc,
        loadPerCore: nproc ? +(load1m / nproc).toFixed(3) : 0
      };
    });
  }

  // ─── IO de disco via iostat (FASE 3) ─────────────────────
  /**
   * `iostat -dxk 1 2` → usa o SEGUNDO bloco (delta real de 1s; o 1º é média
   * desde o boot). Se iostat indisponível: fallback com 1 amostra (média boot).
   * Devices loop/ram são filtrados.
   */
  async getDiskIo(): Promise<HostDiskIo> {
    return this.redis.cached("srv1:diskio", 15, async () => {
      let out = "";
      try { out = (await this.ssh.srv1("iostat -dxk 1 2 2>/dev/null", 15_000)).stdout || ""; } catch { /* fallback abaixo */ }
      let devices = parseIostat(out, true);
      if (!devices.length) {
        try { out = (await this.ssh.srv1("iostat -dxk 2>/dev/null", 10_000)).stdout || ""; } catch { out = ""; }
        devices = parseIostat(out, false);
      }
      return { ts: new Date().toISOString(), devices };
    });
  }

  // ─── Rede: taxas por interface + retransmissão TCP (FASE 3)
  /**
   * Duas leituras de /proc/net/dev com ~1s de intervalo NUM ÚNICO comando SSH
   * → taxa kB/s por interface (delta/1s, clamp ≥ 0) e DELTA de erros/drops na
   * janela. tcpRetransPercent = TcpRetransSegs/TcpOutSegs×100 (acumulado desde
   * boot — via nstat, fallback /proc/net/snmp; null se incalculável). Sem `lo`.
   */
  async getNetwork(): Promise<HostNetwork> {
    return this.redis.cached("srv1:network", 15, async () => {
      const r = await this.ssh.srv1(
        "cat /proc/net/dev; echo '---SPLIT---'; sleep 1; cat /proc/net/dev; " +
        "echo '---TCP---'; (nstat -az TcpRetransSegs TcpOutSegs 2>/dev/null || cat /proc/net/snmp 2>/dev/null)",
        15_000
      ).catch(() => null);
      const out = r?.stdout || "";
      const [devA, rest] = out.split("---SPLIT---");
      const [devB, tcpBlk] = (rest || "").split("---TCP---");
      const a = parseProcNetDev(devA || "");
      const b = parseProcNetDev(devB || "");
      const dtSec = 1; // `sleep 1` no comando
      const ifaces: NetIfaceRate[] = [];
      for (const [iface, cur] of b) {
        if (iface === "lo") continue;
        const prev = a.get(iface);
        if (!prev) continue;
        const d = (x: number, y: number) => Math.max(0, x - y); // clamp: contador pode zerar
        ifaces.push({
          iface,
          rxKbps: +(d(cur.rxBytes, prev.rxBytes) / 1024 / dtSec).toFixed(2),
          txKbps: +(d(cur.txBytes, prev.txBytes) / 1024 / dtSec).toFixed(2),
          rxErrors: d(cur.rxErrs, prev.rxErrs),
          txErrors: d(cur.txErrs, prev.txErrs),
          rxDrops: d(cur.rxDrop, prev.rxDrop),
          txDrops: d(cur.txDrop, prev.txDrop)
        });
      }
      return { ts: new Date().toISOString(), ifaces, tcpRetransPercent: parseTcpRetransPercent(tcpBlk || "") };
    });
  }

  // ─── Systemd services status ────────────────────────────
  async getServices(): Promise<Array<{ name: string; activeState: string; subState: string; description: string }>> {
    return this.redis.cached("srv1:services", 60, async () => {
      const cmd = `systemctl show --property=Id,ActiveState,SubState,Description ${SYSTEMD_TARGETS.join(" ")} --no-pager 2>/dev/null`;
      const result = await this.ssh.srv1(cmd, 10_000);
      const blocks = (result.stdout || "").split(/\n\n+/);
      return blocks.filter(Boolean).map(b => {
        const m: Record<string, string> = {};
        b.split("\n").forEach(l => {
          const [k, v] = l.split("=");
          if (k && v !== undefined) m[k] = v;
        });
        return {
          name: m.Id || "",
          activeState: m.ActiveState || "unknown",
          subState: m.SubState || "unknown",
          description: m.Description || ""
        };
      }).filter(s => s.name);
    });
  }

  // ─── Top processes ──────────────────────────────────────
  async getTopProcesses(by: "cpu" | "mem" = "cpu", limit = 10) {
    return this.redis.cached(`srv1:top:${by}:${limit}`, 30, async () => {
      const sort = by === "cpu" ? "-%cpu" : "-%mem";
      const result = await this.ssh.srv1(`ps aux --sort=${sort} | head -${limit + 1}`, 10_000);
      const lines = (result.stdout || "").split("\n").slice(1, limit + 1);
      return lines.map(l => {
        const cols = l.trim().split(/\s+/);
        return {
          user: cols[0],
          pid: parseInt(cols[1] || "0", 10),
          cpu: parseFloat(cols[2] || "0"),
          mem: parseFloat(cols[3] || "0"),
          rssKb: parseInt(cols[5] || "0", 10),
          command: cols.slice(10).join(" ").slice(0, 200)
        };
      }).filter(p => p.pid > 0);
    });
  }

  // ─── Recent journalctl ──────────────────────────────────
  async tailJournal(unit: string, lines = 100): Promise<string[]> {
    // Whitelist defensiva
    if (!/^[a-zA-Z0-9@._-]+\.service$/.test(unit)) throw new Error("unit inválida");
    const result = await this.ssh.srv1(`journalctl -u ${unit} -n ${Math.min(lines, 500)} --no-pager 2>/dev/null`, 15_000);
    return (result.stdout || "").split("\n");
  }

  // ─── Listening ports ────────────────────────────────────
  async getPorts() {
    return this.redis.cached("srv1:ports", 60, async () => {
      const result = await this.ssh.srv1("ss -tlnp 2>/dev/null | tail -n +2", 10_000);
      const lines = (result.stdout || "").split("\n").filter(Boolean);
      return lines.map(l => {
        const cols = l.split(/\s+/);
        return {
          state: cols[0],
          local: cols[3],
          process: (cols.slice(5).join(" ").match(/\("([^"]+)"/) || [])[1] || "?"
        };
      });
    });
  }
}

/**
 * CPU% a partir de 2 amostras da linha `cpu ...` de /proc/stat (separadas por \n).
 * Campos: user nice system idle iowait irq softirq steal guest guest_nice.
 * busy = total − (idle + iowait). iowait não conta como CPU ocupada; steal conta.
 * Retorna null se não conseguir 2 amostras válidas.
 */
function parseCpuDelta(block: string): number | null {
  const samples = block
    .split("\n")
    .map(l => l.trim())
    .filter(l => /^cpu\s+\d/.test(l))
    .map(l => l.split(/\s+/).slice(1).map(n => parseInt(n, 10) || 0));
  if (samples.length < 2) return null;
  const a = samples[0], b = samples[samples.length - 1];
  const total = (arr: number[]) => arr.reduce((s, v) => s + v, 0);
  const idleOf = (arr: number[]) => (arr[3] || 0) + (arr[4] || 0); // idle + iowait
  const dTotal = total(b) - total(a);
  const dIdle = idleOf(b) - idleOf(a);
  if (dTotal <= 0) return null;
  const busy = ((dTotal - dIdle) / dTotal) * 100;
  return Math.max(0, Math.min(100, +busy.toFixed(2)));
}

function parseMemToMb(s: string): number {
  const m = s.match(/([\d.]+)([KMG]i?B)/i);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const u = m[2].toLowerCase();
  if (u.startsWith("g")) return v * 1024;
  if (u.startsWith("k")) return v / 1024;
  return v;
}

// ─── Helpers de parse FASE 3 (todos tolerantes: input ruim → zeros/null) ──

/** Linhas NDJSON do docker --format '{{json .}}' → objetos (linhas quebradas são descartadas). */
function parseJsonLines(block?: string): any[] {
  return (block || "").trim().split("\n").filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean) as any[];
}

/** "1.2MB", "515.4MiB", "3.4GB", "0B" → bytes. Docker mistura SI (kB/MB) e IEC (KiB/MiB). */
function parseDockerBytes(s?: string): number {
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*([kKmMgGtT]?)(i?)[bB]/);
  if (!m) return 0;
  const v = parseFloat(m[1]);
  const unit = m[2].toLowerCase();
  const base = m[3] ? 1024 : 1000;
  const exp = unit === "k" ? 1 : unit === "m" ? 2 : unit === "g" ? 3 : unit === "t" ? 4 : 0;
  return Math.round(v * Math.pow(base, exp));
}

/** `some avg10=0.12 avg60=0.34 avg300=0.00 total=...` → PsiLine (avg300 pode faltar). */
function parsePsiLine(line: string): PsiLine | null {
  const m = line.match(/avg10=([\d.]+)\s+avg60=([\d.]+)(?:\s+avg300=([\d.]+))?/);
  if (!m) return null;
  return { avg10: parseFloat(m[1]), avg60: parseFloat(m[2]), avg300: m[3] !== undefined ? parseFloat(m[3]) : null };
}

/** Bloco de /proc/pressure/N → { some, full }. `full` não existe p/ CPU em kernels antigos → null. */
function parsePsiBlock(block: string): PsiResource {
  const zero: PsiLine = { avg10: 0, avg60: 0, avg300: 0 };
  let some: PsiLine | null = null;
  let full: PsiLine | null = null;
  for (const l of block.split("\n")) {
    const t = l.trim();
    if (t.startsWith("some")) some = parsePsiLine(t);
    else if (t.startsWith("full")) full = parsePsiLine(t);
  }
  return { some: some ?? zero, full };
}

/** si/so da ÚLTIMA linha de dados do `vmstat 1 2` (2ª amostra = delta real de 1s). */
function parseVmstatSwap(block: string): { si: number | null; so: number | null } {
  const dataLines = block.split("\n").map(l => l.trim()).filter(l => /^\d/.test(l));
  if (!dataLines.length) return { si: null, so: null };
  // Header "r b swpd free buff cache si so bi bo ..." → localiza os índices por nome
  const header = block.split("\n").find(l => /\bsi\b/.test(l) && /\bso\b/.test(l));
  let siIdx = 6, soIdx = 7; // posição padrão do vmstat
  if (header) {
    const cols = header.trim().split(/\s+/);
    const i = cols.indexOf("si"); const o = cols.indexOf("so");
    if (i >= 0) siIdx = i;
    if (o >= 0) soIdx = o;
  }
  const cols = dataLines[dataLines.length - 1].split(/\s+/);
  const si = parseFloat(cols[siIdx] || "");
  const so = parseFloat(cols[soIdx] || "");
  return { si: Number.isFinite(si) ? si : null, so: Number.isFinite(so) ? so : null };
}

/**
 * `iostat -dxk` → devices. Com 2 amostras usa o ÚLTIMO bloco "Device ...".
 * Colunas mapeadas pelo header (nomes variam por versão: aqu-sz vs avgqu-sz).
 */
function parseIostat(out: string, useLastBlock: boolean): DiskIoDevice[] {
  const lines = out.split("\n");
  const headerIdxs: number[] = [];
  lines.forEach((l, i) => { if (/^Device/.test(l.trim())) headerIdxs.push(i); });
  if (!headerIdxs.length) return [];
  const start = useLastBlock ? headerIdxs[headerIdxs.length - 1] : headerIdxs[0];
  const headerCols = lines[start].trim().split(/\s+/);
  const col = (parts: string[], ...names: string[]): number | null => {
    for (const n of names) {
      const i = headerCols.indexOf(n);
      if (i >= 0) {
        const v = parseFloat(parts[i] || "");
        return Number.isFinite(v) ? v : null;
      }
    }
    return null;
  };
  const devices: DiskIoDevice[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) break; // fim do bloco de amostra
    const parts = t.split(/\s+/);
    const device = parts[0];
    if (!device || /^(loop|ram)/.test(device)) continue;
    devices.push({
      device,
      utilPercent: col(parts, "%util") ?? 0,
      readAwaitMs: col(parts, "r_await"),
      writeAwaitMs: col(parts, "w_await"),
      readIops: col(parts, "r/s"),
      writeIops: col(parts, "w/s"),
      readKbps: col(parts, "rkB/s"),
      writeKbps: col(parts, "wkB/s"),
      avgQueueSize: col(parts, "aqu-sz", "avgqu-sz")
    });
  }
  return devices;
}

interface NetDevCounters { rxBytes: number; rxErrs: number; rxDrop: number; txBytes: number; txErrs: number; txDrop: number }

/** /proc/net/dev → contadores por interface (rx: cols 0/2/3; tx: cols 8/10/11 após "iface:"). */
function parseProcNetDev(block: string): Map<string, NetDevCounters> {
  const map = new Map<string, NetDevCounters>();
  for (const line of block.split("\n")) {
    const m = line.match(/^\s*([\w.@-]+):\s*(.*)$/);
    if (!m) continue;
    const nums = m[2].trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
    if (nums.length < 12) continue;
    map.set(m[1], {
      rxBytes: nums[0], rxErrs: nums[2], rxDrop: nums[3],
      txBytes: nums[8], txErrs: nums[10], txDrop: nums[11]
    });
  }
  return map;
}

/** TcpRetransSegs/TcpOutSegs×100 do `nstat -az` ou /proc/net/snmp. null se incalculável. */
function parseTcpRetransPercent(block: string): number | null {
  const retransN = block.match(/TcpRetransSegs\s+(\d+)/)?.[1];
  const outN = block.match(/TcpOutSegs\s+(\d+)/)?.[1];
  if (retransN !== undefined && outN !== undefined) {
    const o = parseInt(outN, 10);
    return o > 0 ? +((parseInt(retransN, 10) / o) * 100).toFixed(3) : null;
  }
  // Fallback /proc/net/snmp: 2 linhas "Tcp:" — header + valores
  const tcpLines = block.split("\n").filter(l => l.startsWith("Tcp:"));
  if (tcpLines.length >= 2) {
    const hdr = tcpLines[0].split(/\s+/);
    const val = tcpLines[1].split(/\s+/);
    const ri = hdr.indexOf("RetransSegs");
    const oi = hdr.indexOf("OutSegs");
    if (ri > 0 && oi > 0) {
      const o = parseInt(val[oi] || "0", 10);
      const rr = parseInt(val[ri] || "0", 10);
      if (o > 0) return +((rr / o) * 100).toFixed(3);
    }
  }
  return null;
}
