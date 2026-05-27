/**
 * HestiaService — re-escopado para "Mail Stack & Sites" do SRV1.
 * (HestiaCP NÃO está instalado no servidor; varredura SRV1 confirmou em 2026-05-27.)
 *
 * Cobre:
 *   - Stalwart mail (docker-mailserver + 4 roundcubes + nextcloud)
 *   - Sites estáticos nginx (clinicafisiomt, fisiomt, trimec, passaro, t4net)
 *   - SSL via acme.sh + Traefik
 *   - Ping HTTP + status code
 */

import { Injectable } from "@nestjs/common";
import axios from "axios";
import { SshService } from "../common/ssh.service";
import { RedisService } from "../common/redis.service";
import { PrismaService } from "../common/prisma.service";

interface SiteCheckResult {
  domain: string;
  scope: "nginx" | "coolify" | "mail" | "webmail" | "nextcloud";
  containerName?: string;
  statusCode?: number;
  responseMs?: number;
  sslExpiresAt?: string | null;
  sslIssuer?: string | null;
  online: boolean;
  error?: string;
}

const DOMAIN_MAP: Array<{ domain: string; scope: SiteCheckResult["scope"]; containerName?: string }> = [
  { domain: "controler.net.br", scope: "coolify", containerName: "controler" },
  { domain: "myclinicsoft.com.br", scope: "coolify", containerName: "myclinicsoft" },
  { domain: "libertakidz.com.br", scope: "coolify", containerName: "libertakidz-backend" },
  { domain: "manalista.com.br", scope: "coolify", containerName: "manalista" },
  { domain: "laudo.fisiomt.com.br", scope: "coolify", containerName: "fisiomt-laudo" },
  { domain: "painel.fisiomt.com.br", scope: "coolify", containerName: "fisiomt-painel" },
  { domain: "passaroprofessor.com.br", scope: "coolify", containerName: "passaro-professor" },
  { domain: "fisiomt.com.br", scope: "nginx", containerName: "fisiomt-web" },
  { domain: "clinicafisiomt.com.br", scope: "nginx", containerName: "clinicafisiomt-web" },
  { domain: "trimec.com.br", scope: "nginx", containerName: "trimec-web" },
  { domain: "mail.fisiomt.com.br", scope: "mail", containerName: "mailserver" },
  { domain: "webmail.fisiomt.com.br", scope: "webmail", containerName: "roundcube-fisiomt" },
  { domain: "webmail.clinicafisiomt.com.br", scope: "webmail", containerName: "roundcube-clinicafisiomt" },
  { domain: "webmail.trimec.com.br", scope: "webmail", containerName: "roundcube-trimec" },
  { domain: "nextcloud.controler.net.br", scope: "nextcloud", containerName: "nextcloud" }
];

@Injectable()
export class HestiaService {
  constructor(
    private readonly ssh: SshService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService
  ) {}

  async listSites(): Promise<SiteCheckResult[]> {
    return this.redis.cached("hestia:sites", 60, async () => {
      const results = await Promise.all(DOMAIN_MAP.map(d => this.checkOne(d)));
      // upsert no DB
      await Promise.all(results.map(r =>
        this.prisma.site.upsert({
          where: { domain: r.domain },
          update: {
            scope: r.scope, containerName: r.containerName, sslIssuer: r.sslIssuer,
            sslExpiresAt: r.sslExpiresAt ? new Date(r.sslExpiresAt) : null,
            lastCheckedAt: new Date(), statusCode: r.statusCode, responseMs: r.responseMs
          },
          create: {
            domain: r.domain, scope: r.scope, containerName: r.containerName,
            sslIssuer: r.sslIssuer, sslExpiresAt: r.sslExpiresAt ? new Date(r.sslExpiresAt) : null,
            lastCheckedAt: new Date(), statusCode: r.statusCode, responseMs: r.responseMs
          }
        })
      ));
      return results;
    });
  }

  private async checkOne(item: typeof DOMAIN_MAP[number]): Promise<SiteCheckResult> {
    const t0 = Date.now();
    try {
      const url = item.scope === "mail" ? `https://${item.domain}` : `https://${item.domain}/`;
      const res = await axios.get(url, {
        timeout: 8_000, validateStatus: () => true, maxRedirects: 3,
        headers: { "User-Agent": "controler-v4-noc/1.0" }
      });
      const responseMs = Date.now() - t0;
      const ssl = await this.fetchSslInfo(item.domain).catch(() => null);
      return {
        ...item,
        statusCode: res.status,
        responseMs,
        online: res.status < 500,
        sslIssuer: ssl?.issuer ?? null,
        sslExpiresAt: ssl?.expiresAt ?? null
      };
    } catch (err: any) {
      return { ...item, online: false, error: err?.code || err?.message };
    }
  }

  private async fetchSslInfo(domain: string): Promise<{ issuer: string; expiresAt: string } | null> {
    const cmd = `echo | openssl s_client -servername ${domain} -connect ${domain}:443 -showcerts 2>/dev/null | openssl x509 -noout -issuer -enddate 2>/dev/null`;
    const result = await this.ssh.srv1(cmd, 8_000);
    if (!result.stdout) return null;
    const issuerMatch = result.stdout.match(/issuer=(.+)/);
    const dateMatch = result.stdout.match(/notAfter=(.+)/);
    if (!issuerMatch || !dateMatch) return null;
    return {
      issuer: issuerMatch[1].trim(),
      expiresAt: new Date(dateMatch[1].trim()).toISOString()
    };
  }

  async mailStackStatus() {
    return this.redis.cached("hestia:mail-stack", 60, async () => {
      const result = await this.ssh.srv1(
        `docker ps --filter "name=mail" --filter "name=roundcube" --filter "name=nextcloud" --filter "name=stalwart" --format '{{.Names}}|{{.Status}}|{{.Image}}'`,
        10_000
      );
      return (result.stdout || "").split("\n").filter(Boolean).map(l => {
        const [name, status, image] = l.split("|");
        return { name, status, image };
      });
    });
  }
}
