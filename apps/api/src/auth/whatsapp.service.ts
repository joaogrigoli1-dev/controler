/**
 * WhatsappService — envio de OTP com 3 canais em fallback:
 *   1. Meta WhatsApp Business API (free-form text)  → primário
 *   2. Z-API (WhatsApp não-oficial)                 → secundário
 *   3. Infobip SMS                                  → terciário (garantido)
 *
 * Em 28/05/2026 descobrimos:
 *   - Z-API instance 3EF4B042... retorna "Instance not found" (morta)
 *   - Meta phone 1097542773446130 retorna "account is not registered" (133010)
 *   - Solução: SMS via Infobip vira o canal funcional + admin backdoor /be/auth/dev-otp
 *
 * Throttle de 60s/destinatário aplicado em qualquer canal para anti-abuso.
 */

import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { SsmService } from "../common/ssm.service";
import { RedisService } from "../common/redis.service";

@Injectable()
export class WhatsappService {
  private readonly log = new Logger("WhatsApp");

  constructor(private readonly ssm: SsmService, private readonly redis: RedisService) {}

  private async credsZapi() {
    const instance =
      process.env.ZAPI_INSTANCE_ID ||
      (await this.ssm.get("/shared/zapi/instance_id")) ||
      (await this.ssm.get("/myclinicsoft/zapi_instance_id"));
    const token =
      process.env.ZAPI_TOKEN ||
      (await this.ssm.get("/shared/zapi/token")) ||
      (await this.ssm.get("/myclinicsoft/zapi_token"));
    const clientToken =
      process.env.ZAPI_CLIENT_TOKEN ||
      (await this.ssm.get("/myclinicsoft/zapi_client_token"));
    if (!instance || !token) throw new Error("Z-API instance/token não configurados");
    return { instance, token, clientToken };
  }

  private async credsMeta() {
    const token = process.env.META_WHATSAPP_TOKEN || (await this.ssm.get("/myclinicsoft/whatsapp/access_token"));
    const phoneId = process.env.META_WHATSAPP_PHONE_ID || (await this.ssm.get("/myclinicsoft/whatsapp/phone_number_id")) || "1097542773446130";
    if (!token || !phoneId) throw new Error("Meta WhatsApp não configurado");
    return { token, phoneId };
  }

  private async credsInfobip() {
    const apiKey = process.env.INFOBIP_API_KEY || (await this.ssm.get("/myclinicsoft/infobip_api_key")) || (await this.ssm.get("/shared/infobip/api_key"));
    const baseUrl = (await this.ssm.get("/shared/infobip/base_url")) || (await this.ssm.get("/myclinicsoft/infobip_base_url")) || "6zjrk8.api.infobip.com";
    if (!apiKey) throw new Error("Infobip não configurado");
    return { apiKey, baseUrl };
  }

  /**
   * Envia código OTP. Aplica dedup + throttle por destinatário.
   * Retorna { sent: bool, provider, error? }.
   */
  async sendOtp(phone: string, code: string): Promise<{ sent: boolean; provider: string; error?: string }> {
    const phoneClean = phone.replace(/\D/g, "");
    const phoneWith55 = phoneClean.startsWith("55") ? phoneClean : `55${phoneClean}`;

    // Throttle: 1 OTP/destinatário/minuto (defesa contra abuso de "request-code")
    const throttleKey = `wa:otp:throttle:${phoneWith55}`;
    const lock = await this.redis.client.set(throttleKey, "1", "EX", 60, "NX").catch(() => null);
    if (lock !== "OK") {
      this.log.warn(`OTP throttled for ${phoneWith55}`);
      return { sent: false, provider: "zapi", error: "throttled" };
    }

    const variants = [
      `🔐 *Controler NOC*\n\nSeu código: *${code}*\n\nVálido por 10 minutos. Não compartilhe.`,
      `Olá! Código de acesso ao Controler: *${code}*\n\nExpira em 10 min.`,
      `Controler NOC ✅\n\nCódigo: *${code}*\n\nVálido por 10min.`
    ];
    const msg = variants[Math.floor(Math.random() * variants.length)];

    // Tenta canais em ordem: Meta → Z-API → SMS Infobip. Primeiro que retornar `sent` ganha.
    const channels: Array<() => Promise<{ sent: boolean; provider: string; error?: string }>> = [
      () => this.trySendMeta(phoneWith55, msg, code),
      () => this.trySendZapi(phoneWith55, msg),
      () => this.trySendSms(phoneWith55, code)
    ];
    for (const ch of channels) {
      const result = await ch().catch((e) => ({ sent: false, provider: "?", error: String(e?.message || e) }));
      if (result.sent) return result;
      this.log.warn(`[OTP] canal ${result.provider} falhou (${result.error}), tentando próximo`);
    }
    return { sent: false, provider: "all-failed", error: "todos os canais falharam" };
  }

  // ─── Canal 1: Meta WhatsApp Business API ────────────────
  private async trySendMeta(phone: string, msg: string, _code: string): Promise<{ sent: boolean; provider: string; error?: string }> {
    try {
      const { token, phoneId } = await this.credsMeta();
      const { data, status } = await axios.post(
        `https://graph.facebook.com/v18.0/${phoneId}/messages`,
        { messaging_product: "whatsapp", to: phone, type: "text", text: { body: msg } },
        { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, timeout: 15_000, validateStatus: () => true }
      );
      if (status >= 400 || data?.error) {
        return { sent: false, provider: "meta", error: `status=${status} ${data?.error?.message || ""}`.slice(0, 200) };
      }
      this.log.log(`[Meta] OTP enviado phone=${phone} id=${data?.messages?.[0]?.id}`);
      return { sent: true, provider: "meta" };
    } catch (err: any) {
      return { sent: false, provider: "meta", error: err?.message };
    }
  }

  // ─── Canal 2: Z-API ─────────────────────────────────────
  private async trySendZapi(phone: string, msg: string): Promise<{ sent: boolean; provider: string; error?: string }> {
    try {
      const { instance, token, clientToken } = await this.credsZapi();
      const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (clientToken) headers["Client-Token"] = clientToken;
      const { data, status } = await axios.post(url, { phone, message: msg }, { headers, timeout: 15_000, validateStatus: () => true });
      if (status >= 400 || data?.error || !data?.messageId) {
        return { sent: false, provider: "zapi", error: `status=${status} ${JSON.stringify(data).slice(0, 150)}` };
      }
      this.log.log(`[Z-API] OTP enviado phone=${phone} id=${data.messageId}`);
      return { sent: true, provider: "zapi" };
    } catch (err: any) {
      return { sent: false, provider: "zapi", error: err?.message };
    }
  }

  // ─── Canal 3: SMS via Infobip ───────────────────────────
  private async trySendSms(phone: string, code: string): Promise<{ sent: boolean; provider: string; error?: string }> {
    try {
      const { apiKey, baseUrl } = await this.credsInfobip();
      const text = `Controler NOC: ${code}\n(valido por 10 min)`;
      const { data, status } = await axios.post(
        `https://${baseUrl}/sms/2/text/advanced`,
        { messages: [{ from: "Controler", destinations: [{ to: phone }], text }] },
        { headers: { Authorization: `App ${apiKey}`, "Content-Type": "application/json" }, timeout: 15_000, validateStatus: () => true }
      );
      if (status >= 400 || data?.requestError) {
        return { sent: false, provider: "sms", error: `status=${status} ${JSON.stringify(data).slice(0, 150)}` };
      }
      this.log.log(`[SMS] OTP enviado phone=${phone} id=${data?.messages?.[0]?.messageId}`);
      return { sent: true, provider: "sms" };
    } catch (err: any) {
      return { sent: false, provider: "sms", error: err?.message };
    }
  }

  /**
   * Checa status da instância Z-API. Retorna { connected, raw }.
   * Usado pelo /be/auth/diagnostic para admin verificar saúde do canal.
   */
  async statusInstance(): Promise<{ connected: boolean; raw: unknown; error?: string }> {
    try {
      const { instance, token, clientToken } = await this.creds();
      const headers: Record<string, string> = {};
      if (clientToken) headers["Client-Token"] = clientToken;
      const { data, status } = await axios.get(
        `https://api.z-api.io/instances/${instance}/token/${token}/status`,
        { headers, timeout: 10_000, validateStatus: () => true }
      );
      const connected = status === 200 && (data?.connected === true || data?.session === "CONNECTED");
      if (!connected) {
        this.log.warn(`[Z-API] instance NOT connected: status=${status} data=${JSON.stringify(data).slice(0, 200)}`);
      }
      return { connected, raw: data };
    } catch (err: any) {
      this.log.error(`[Z-API] status check failed: ${err?.message}`);
      return { connected: false, raw: null, error: err?.message };
    }
  }
}
