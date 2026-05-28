import { Injectable, NotFoundException } from "@nestjs/common";
import { SsmService } from "../common/ssm.service";
import { PrismaService } from "../common/prisma.service";

const PROJECT_PREFIXES = ["/controler", "/myclinicsoft", "/libertakidz", "/manalista", "/fisiomt", "/passaro"];

@Injectable()
export class VaultService {
  constructor(private readonly ssm: SsmService, private readonly prisma: PrismaService) {}

  async listByProject(prefix?: string) {
    const prefixes = prefix ? [prefix] : PROJECT_PREFIXES;
    const all: any[] = [];
    for (const p of prefixes) {
      try {
        const params = await this.ssm.listByPath(p, false);
        params.forEach(param => {
          const parts = (param.Name || "").split("/").filter(Boolean);
          all.push({
            name: param.Name,
            type: param.Type,
            value: param.Value, // já mascarado se SecureString
            lastModified: param.LastModifiedDate,
            project: parts[0] || "root",
            group: parts.slice(1, -1).join("/") || "",
            key: parts[parts.length - 1] || param.Name
          });
        });
      } catch {
        /* ignore prefix without params */
      }
    }
    return all;
  }

  async reveal(name: string, userId: string, ip: string, userAgent?: string) {
    const value = await this.ssm.get(name, false);
    if (value === null) throw new NotFoundException(`Param ${name} não encontrado`);
    await this.prisma.vaultAuditLog.create({
      data: { userId, action: "REVEAL", resource: name, ipAddress: ip, userAgent }
    });
    return { name, value, revealedAt: new Date(), expiresInSec: 60 };
  }

  async auditLog(filter?: { userId?: string; resource?: string; limit?: number }) {
    return this.prisma.vaultAuditLog.findMany({
      where: { userId: filter?.userId, resource: filter?.resource },
      orderBy: { createdAt: "desc" },
      take: filter?.limit ?? 100,
      include: { user: { select: { name: true, email: true } } }
    });
  }
}
