/**
 * AlertsService — roteamento de alertas, convenção João:
 *   - WhatsApp: SEMPRE 2 rotas, Z-API (principal) + Meta API oficial (fallback)
 *   - SMS:      SEMPRE Infobip
 *
 * Roteamento por severidade:
 *   CRITICAL → WhatsApp (Z-API → Meta fallback) + SMS Infobip, 24/7
 *   WARNING  → WhatsApp (Z-API → Meta fallback), respeita janela silêncio 22h-7h BRT
 *   INFO     → apenas log + WebSocket
 */

import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { PrismaService } from "../common/prisma.service";
import { SsmService } from "../common/ssm.service";
import { RedisService } from "../common/redis.service";

const ALERT_PHONE = process.env.ALERT_PHONE_DEFAULT || "556598466555";
const COOLDOWN_PREFIX = "alert:cooldown:";
const DEFAULT_COOLDOWN_MIN = 30;

export interface DispatchInput {
  ruleKey: string;
  ruleId?: string;
  severity: "info" | "warning" | "critical";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
  forceChannels?: string[];
}

@Injectable()
export class AlertsService {
  private readonly log = new Logger("Alerts");

  constructor(
    private readonly prisma: PrismaService,
    private readonly ssm: SsmService,
    private readonly redis: RedisService
  ) {}

  // ─── 1. Dispatch ────────────────────────────────────────
  async dispatch(input: DispatchInput): Promise<{ sent: boolean; reason?: string }> {
    const sev = input.severity;
    const channels = input.forceChannels || this.channelsFor(sev);

    // Cooldown check (per ruleKey)
    const cooldownKey = `${COOLDOWN_PREFIX}${input.ruleKey}`;
    const cooled = await this.redis.client.get(cooldownKey).catch(() => null);
    if (cooled && sev !== "critical") {
      return { sent: false, reason: "cooldown" };
    }

    // Silence window (22h-7h BRT) só bloqueia WARNING e INFO
    if (sev !== "critical" && this.inSilenceWindow()) {
      await this.persistLog({ ...input, channels, sent: false, error: "silence_window" });
      return { sent: false, reason: "silence_window" };
    }

    // Send channels in parallel
    const results = await Promise.all(channels.map(ch => this.sendVia(ch, input)));
    const allOk = results.every(r => r.ok);
    const error = results.find(r => !r.ok)?.error;

    await this.persistLog({ ...input, channels, sent: allOk, error });
    if (allOk) {
      await this.redis.client.setex(cooldownKey, DEFAULT_COOLDOWN_MIN * 60, "1").catch(() => {});
    }
    return { sent: allOk, reason: error };
  }

  // ─── 2. Channels ────────────────────────────────────────
  private channelsFor(sev: string): string[] {
    if (sev === "critical") return ["whatsapp", "sms"];
    if (sev === "warning") return ["whatsapp"];
    return ["internal"]; // info
  }

  private inSilenceWindow(): boolean {
    const brt = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
    const h = brt.getHours();
    return h >= 22 || h < 7;
  }

  private async sendVia(ch: string, input: DispatchInput): Promise<{ ok: boolean; error?: string }> {
    try {
      if (ch === "whatsapp") {
        // Convenção João: WhatsApp = Z-API (principal) → Meta (oficial fallback)
        const txt = `${this.icon(input.severity)} *${input.title}*\n\n${input.message}\n\n_controler NOC_`;
        const zapiResult = await this.sendWhatsappZapi(ALERT_PHONE, txt);
        if (zapiResult.ok) return zapiResult;
        this.log.warn(`[Alert] WhatsApp Z-API falhou (${zapiResult.error}), tentando Meta oficial`);
        const metaResult = await this.sendWhatsappMeta(ALERT_PHONE, txt);
        if (metaResult.ok) return metaResult;
        return { ok: false, error: `whatsapp falhou em Z-API + Meta: ${metaResult.error}` };
      }
      if (ch === "sms") {
        // Convenção João: SMS = sempre Infobip
        return await this.sendSmsInfobip(ALERT_PHONE, `[${input.severity.toUpperCase()}] ${input.title}: ${input.message}`);
      }
      // internal = só log + websocket (broadcast)
      return { ok: true };
    } catch (err: any) {
      this.log.warn(`sendVia(${ch}) failed: ${err?.message}`);
      return { ok: false, error: err?.message };
    }
  }

  // ─── Canais individuais (separados para testabilidade) ──
  private async sendWhatsappZapi(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const instance = process.env.ZAPI_INSTANCE_ID || (await this.ssm.get("/shared/zapi/instance_id")) || (await this.ssm.get("/myclinicsoft/zapi_instance_id"));
    const token = process.env.ZAPI_TOKEN || (await this.ssm.get("/shared/zapi/token")) || (await this.ssm.get("/myclinicsoft/zapi_token"));
    const clientToken = await this.ssm.get("/myclinicsoft/zapi_client_token");
    if (!instance || !token) return { ok: false, error: "zapi-not-configured" };
    const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (clientToken) headers["Client-Token"] = clientToken;
    const { data, status } = await axios.post(url, { phone, message: text }, { headers, timeout: 12_000, validateStatus: () => true });
    if (status >= 400 || data?.error || !data?.messageId) {
      return { ok: false, error: `zapi status=${status} ${JSON.stringify(data).slice(0, 120)}` };
    }
    return { ok: true };
  }

  private async sendWhatsappMeta(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const token = process.env.META_WHATSAPP_TOKEN || (await this.ssm.get("/myclinicsoft/whatsapp/access_token"));
    const phoneId = process.env.META_WHATSAPP_PHONE_ID || (await this.ssm.get("/myclinicsoft/whatsapp/phone_number_id")) || "1097542773446130";
    if (!token || !phoneId) return { ok: false, error: "meta-not-configured" };
    const { data, status } = await axios.post(
      `https://graph.facebook.com/v18.0/${phoneId}/messages`,
      { messaging_product: "whatsapp", to: phone, type: "text", text: { body: text } },
      { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 12_000, validateStatus: () => true }
    );
    if (status >= 400 || data?.error) {
      return { ok: false, error: `meta status=${status} ${data?.error?.message || ""}`.slice(0, 150) };
    }
    return { ok: true };
  }

  private async sendSmsInfobip(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const apiKey = process.env.INFOBIP_API_KEY || (await this.ssm.get("/shared/infobip/api_key"));
    const base = (await this.ssm.get("/shared/infobip/base_url")) || "6zjrk8.api.infobip.com";
    if (!apiKey) return { ok: false, error: "infobip-not-configured" };
    const { data, status } = await axios.post(
      `https://${base}/sms/2/text/advanced`,
      { messages: [{ from: "Controler", destinations: [{ to: phone }], text }] },
      { headers: { Authorization: `App ${apiKey}` }, timeout: 12_000, validateStatus: () => true }
    );
    if (status >= 400 || data?.requestError) {
      return { ok: false, error: `infobip status=${status}` };
    }
    return { ok: true };
  }

  private icon(sev: string): string {
    return sev === "critical" ? "🔴" : sev === "warning" ? "🟡" : "🔵";
  }

  private async persistLog(args: any) {
    await this.prisma.alertLog.create({
      data: {
        ruleKey: args.ruleKey,
        ruleId: args.ruleId,
        severity: args.severity,
        title: args.title,
        message: args.message,
        channels: args.channels,
        sent: args.sent,
        error: args.error,
        metadata: args.metadata || undefined
      }
    });
  }

  // ─── 3. Rules CRUD ──────────────────────────────────────
  listRules() {
    return this.prisma.alertRule.findMany({ orderBy: { createdAt: "desc" } });
  }
  createRule(data: any) {
    return this.prisma.alertRule.create({ data });
  }
  updateRule(id: string, data: any) {
    return this.prisma.alertRule.update({ where: { id }, data });
  }
  deleteRule(id: string) {
    return this.prisma.alertRule.delete({ where: { id } });
  }

  async silenceRule(id: string, hours: number) {
    return this.prisma.alertRule.update({
      where: { id },
      data: { silencedUntil: new Date(Date.now() + hours * 3600_000) }
    });
  }

  // ─── 4. Logs / summary ──────────────────────────────────
  recentLogs(limit = 100) {
    return this.prisma.alertLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  }

  async summary() {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [total, critical, warning, info, last24, silenced] = await Promise.all([
      this.prisma.alertLog.count(),
      this.prisma.alertLog.count({ where: { severity: "critical" } }),
      this.prisma.alertLog.count({ where: { severity: "warning" } }),
      this.prisma.alertLog.count({ where: { severity: "info" } }),
      this.prisma.alertLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.alertRule.count({ where: { silencedUntil: { gt: new Date() } } })
    ]);
    return { total, critical, warning, info, last24h: last24, silenced };
  }
}
