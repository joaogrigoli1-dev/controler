/**
 * ScannerService — herda funcionalidade de core/scanner.py
 *   - containers parados > 7d → warning
 *   - images dangling → info (com action_safe = docker image prune -f)
 *   - volumes dangling → info
 *   - build cache → info (com action_safe = docker builder prune -f)
 *   - serviços systemd failed
 */

import { Injectable } from "@nestjs/common";
import { SshService } from "../common/ssh.service";
import { PrismaService } from "../common/prisma.service";

const SAFE = new Set(["docker image prune -f", "docker builder prune -f", "docker volume prune -f"]);

@Injectable()
export class ScannerService {
  constructor(private readonly ssh: SshService, private readonly prisma: PrismaService) {}

  async runAll() {
    const findings: Array<{ category: string; severity: string; title: string; detail?: string; metadata?: any; actionSafe?: boolean; action?: string }> = [];

    // 1. stopped containers
    const stopped = await this.ssh.srv1(`docker ps -a --filter status=exited --format '{{.Names}}|{{.Status}}'`).catch(() => null);
    (stopped?.stdout || "").split("\n").filter(Boolean).forEach(l => {
      const [name, status] = l.split("|");
      const m = status.match(/Exited.*?(\d+)\s*days/);
      const days = m ? parseInt(m[1], 10) : 0;
      findings.push({
        category: "stopped_containers",
        severity: days > 7 ? "warning" : "info",
        title: `Container parado: ${name}`,
        detail: status,
        metadata: { name, days }
      });
    });

    // 2. dangling images
    const dangling = await this.ssh.srv1(`docker images -f dangling=true -q | wc -l`).catch(() => null);
    const danglingCount = parseInt((dangling?.stdout || "0").trim(), 10);
    if (danglingCount > 0) {
      findings.push({
        category: "dangling_images",
        severity: danglingCount > 20 ? "warning" : "info",
        title: `${danglingCount} imagens Docker sem tag`,
        action: "docker image prune -f",
        actionSafe: true,
        metadata: { count: danglingCount }
      });
    }

    // 3. build cache
    const cache = await this.ssh.srv1(`docker system df --format '{{json .}}' 2>/dev/null`).catch(() => null);
    if (cache?.stdout) {
      try {
        const lines = cache.stdout.split("\n").filter(Boolean).map(l => JSON.parse(l));
        const buildCache = lines.find((l: any) => (l.Type || "") === "Build Cache");
        if (buildCache && buildCache.Reclaimable && parseFloat(buildCache.Reclaimable) > 1) {
          findings.push({
            category: "build_cache",
            severity: "info",
            title: `Build cache reclamável: ${buildCache.Reclaimable}`,
            action: "docker builder prune -f",
            actionSafe: true,
            metadata: { reclaimable: buildCache.Reclaimable }
          });
        }
      } catch { /* ignore */ }
    }

    // 4. failed systemd
    const failed = await this.ssh.srv1(`systemctl list-units --state=failed --type=service --no-legend --no-pager`).catch(() => null);
    (failed?.stdout || "").split("\n").filter(Boolean).forEach(l => {
      const name = l.trim().split(/\s+/)[1] || l.trim().split(/\s+/)[0];
      findings.push({
        category: "failed_services",
        severity: "warning",
        title: `Serviço falhado: ${name}`,
        action: `systemctl reset-failed ${name}`,
        actionSafe: false
      });
    });

    // persist
    if (findings.length) {
      await this.prisma.scannerFinding.createMany({ data: findings });
    }
    return { count: findings.length, findings };
  }

  async listFindings(resolved = false) {
    return this.prisma.scannerFinding.findMany({
      where: { resolved },
      orderBy: { createdAt: "desc" },
      take: 200
    });
  }

  async executeSafeAction(id: string) {
    const f = await this.prisma.scannerFinding.findUnique({ where: { id } });
    if (!f) throw new Error("not found");
    if (!f.action || !SAFE.has(f.action)) {
      throw new Error(`Ação não está na whitelist: ${f.action}`);
    }
    const result = await this.ssh.srv1(f.action, 60_000);
    await this.prisma.scannerFinding.update({
      where: { id },
      data: { resolved: true, resolvedAt: new Date() }
    });
    return { ok: result.exitCode === 0, stdout: result.stdout, stderr: result.stderr };
  }
}
