/**
 * Srv1Service — agrega métricas do SRV1 via Hostinger API + SSH + Docker.
 * Cache Redis 30s para snapshots de host; 10s para containers; 60s para systemd.
 */

import { Injectable, Logger } from "@nestjs/common";
import { HostingerService } from "../common/hostinger.service";
import { SshService } from "../common/ssh.service";
import { RedisService } from "../common/redis.service";
import type { HostMetrics, ContainerSummary } from "../shared";

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

  // ─── Containers via docker ps + docker stats no SRV1 ────
  async getContainers(): Promise<ContainerSummary[]> {
    return this.redis.cached("srv1:containers", 10, async () => {
      const result = await this.ssh.srv1(
        `docker ps -a --format '{{json .}}' && echo '---STATS---' && docker stats --no-stream --format '{{json .}}'`
      );
      const out = result.stdout || "";
      const [psBlock, statsBlock] = out.split("---STATS---");
      const ps = (psBlock || "").trim().split("\n").filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as any[];
      const stats = (statsBlock || "").trim().split("\n").filter(Boolean).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean) as any[];
      const statByName: Record<string, any> = {};
      stats.forEach(s => { statByName[s.Name] = s; });

      return ps.map(c => {
        const s = statByName[c.Names];
        const cpu = s?.CPUPerc ? parseFloat(s.CPUPerc.replace("%", "")) : 0;
        const memPerc = s?.MemPerc ? parseFloat(s.MemPerc.replace("%", "")) : 0;
        const memUsage = s?.MemUsage?.split("/")[0]?.trim() || "0MiB";
        const memMb = parseMemToMb(memUsage);
        const status: string = c.Status || "";
        const state: string = c.State || "";
        let hc: ContainerSummary["healthcheck"] = "none";
        if (status.includes("(healthy)")) hc = "healthy";
        else if (status.includes("(unhealthy)")) hc = "unhealthy";
        else if (status.includes("(starting)") || status.includes("(health: starting)")) hc = "starting";
        return {
          name: c.Names,
          image: c.Image,
          status,
          state: state || (status.startsWith("Up") ? "running" : "exited"),
          cpuPercent: cpu,
          memMb,
          memPercent: memPerc,
          uptime: status.replace(/^Up\s+/, "").split(" (")[0],
          healthcheck: hc,
          ports: c.Ports ? c.Ports.split(", ") : []
        };
      });
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
