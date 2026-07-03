/**
 * SslScheduler — FASE 3 (catálogo A.4): probe SSL direto do container (sem SSH).
 *
 * A cada 6h (+ primeira coleta 2min após o boot): para cada Site do banco
 * + o próprio noc.controler.net.br, abre conexão TLS direta do Node
 * (tls.connect 443, SNI, rejectUnauthorized=false — queremos LER o cert,
 * não validar a cadeia) e extrai notAfter / issuer CN / daysRemaining.
 *
 * Persiste SslCheckHistory (sucesso E falha) e atualiza Site.sslExpiresAt/sslIssuer.
 * Alertas: daysRemaining <= 7 → CRITICAL ssl_critical_<domain>;
 *          daysRemaining <= 30 → WARNING ssl_warning_<domain>.
 * Anti-flood: guarda Redis de 20h por domínio (máx. 1 alerta/dia — critical
 * ignora o cooldown nativo do AlertsService).
 */

import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import * as tls from "tls";
import { PrismaService } from "../common/prisma.service";
import { RedisService } from "../common/redis.service";
import { AlertsService } from "../alerts/alerts.service";

const FIRST_RUN_DELAY_MS = 2 * 60_000; // 2min após o boot
const PROBE_TIMEOUT_MS = 8_000;
const ALERT_GUARD_PREFIX = "ssl:alerted:";
const ALERT_GUARD_TTL_SEC = 20 * 3600; // ~1 alerta/dia por domínio
const EXTRA_DOMAINS = ["noc.controler.net.br"];

interface SslProbeResult {
  ok: boolean;
  notAfter?: Date;
  daysRemaining?: number;
  issuer?: string | null;
  error?: string;
}

@Injectable()
export class SslScheduler implements OnModuleInit {
  private readonly log = new Logger("SslScheduler");

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly alerts: AlertsService
  ) {}

  onModuleInit() {
    // Primeira coleta com atraso — deixa o app subir e o banco/SSM estabilizarem
    const t = setTimeout(() => {
      this.runAll().catch(err => this.log.warn(`primeira coleta SSL falhou: ${err?.message}`));
    }, FIRST_RUN_DELAY_MS);
    (t as any).unref?.();
  }

  @Cron("0 */6 * * *", { name: "ssl-probe" })
  async cronTick() {
    await this.runAll().catch(err => this.log.warn(`coleta SSL falhou: ${err?.message}`));
  }

  async runAll() {
    let domains: string[] = [];
    try {
      const sites = await this.prisma.site.findMany({ select: { domain: true } });
      domains = sites.map(s => s.domain);
    } catch (err: any) {
      this.log.warn(`site.findMany falhou: ${err?.message}`);
    }
    const all = Array.from(new Set([...domains, ...EXTRA_DOMAINS]));
    this.log.log(`probe SSL de ${all.length} domínios`);
    for (const domain of all) {
      try {
        await this.checkDomain(domain);
      } catch (err: any) {
        this.log.warn(`checkDomain(${domain}): ${err?.message}`);
      }
    }
  }

  private async checkDomain(domain: string) {
    const r = await this.probe(domain);

    // Histórico (sucesso e falha — a falha também é sinal)
    await this.prisma.sslCheckHistory
      .create({
        data: {
          domain,
          ok: r.ok,
          notAfter: r.notAfter ?? null,
          daysRemaining: r.daysRemaining ?? null,
          issuer: r.issuer ?? null,
          error: r.error ?? null
        }
      })
      .catch(err => this.log.warn(`sslCheckHistory(${domain}): ${err?.message}`));

    if (r.ok && r.notAfter) {
      await this.prisma.site
        .updateMany({
          where: { domain },
          data: { sslExpiresAt: r.notAfter, sslIssuer: r.issuer ?? null }
        })
        .catch(err => this.log.warn(`site.updateMany(${domain}): ${err?.message}`));
    }

    if (r.ok && typeof r.daysRemaining === "number") {
      if (r.daysRemaining <= 7) {
        await this.dispatchGuarded(domain, "critical", r.daysRemaining, r.notAfter);
      } else if (r.daysRemaining <= 30) {
        await this.dispatchGuarded(domain, "warning", r.daysRemaining, r.notAfter);
      }
    }
  }

  private async dispatchGuarded(domain: string, severity: "critical" | "warning", days: number, notAfter?: Date) {
    const ruleKey = severity === "critical" ? `ssl_critical_${domain}` : `ssl_warning_${domain}`;
    const guardKey = `${ALERT_GUARD_PREFIX}${ruleKey}`;
    const already = await this.redis.client.get(guardKey).catch(() => null);
    if (already) return;
    await this.redis.client.setex(guardKey, ALERT_GUARD_TTL_SEC, "1").catch(() => {});
    await this.alerts
      .dispatch({
        ruleKey,
        severity,
        title: `SSL de ${domain} expira em ${days} dia(s)`,
        message: `O certificado de ${domain} expira em ${days} dia(s)${notAfter ? ` (${notAfter.toISOString().slice(0, 10)})` : ""}. Renove via acme.sh/Traefik.`,
        metadata: { domain, daysRemaining: days }
      })
      .catch(err => this.log.warn(`dispatch ssl(${domain}): ${err?.message}`));
  }

  /** Conexão TLS direta (SNI). rejectUnauthorized=false: queremos ler o cert mesmo expirado/inválido. */
  private probe(host: string): Promise<SslProbeResult> {
    return new Promise(resolve => {
      let settled = false;
      let socket: tls.TLSSocket | null = null;
      const done = (r: SslProbeResult) => {
        if (settled) return;
        settled = true;
        try {
          socket?.destroy();
        } catch {}
        resolve(r);
      };
      try {
        socket = tls.connect(443, host, { servername: host, rejectUnauthorized: false }, () => {
          try {
            const cert = socket!.getPeerCertificate();
            if (!cert || !cert.valid_to) return done({ ok: false, error: "certificado ausente" });
            const notAfter = new Date(cert.valid_to);
            if (Number.isNaN(notAfter.getTime())) return done({ ok: false, error: `valid_to inválido: ${cert.valid_to}` });
            const daysRemaining = Math.floor((notAfter.getTime() - Date.now()) / 86_400_000);
            const issuer = (cert.issuer && (cert.issuer.CN || (cert.issuer as any).O)) || null;
            done({ ok: true, notAfter, daysRemaining, issuer });
          } catch (err: any) {
            done({ ok: false, error: err?.message });
          }
        });
        socket.setTimeout(PROBE_TIMEOUT_MS, () => done({ ok: false, error: "timeout" }));
        socket.on("error", err => done({ ok: false, error: err?.message }));
      } catch (err: any) {
        done({ ok: false, error: err?.message });
      }
    });
  }
}
