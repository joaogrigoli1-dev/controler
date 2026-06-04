/**
 * OtpDeliveryService — envio de OTP via WhatsApp (Z-API).
 *
 * Política em vigor (29/05/2026): OTP é enviado EXCLUSIVAMENTE via Z-API.
 * Meta WhatsApp Business e SMS Infobip permanecem ativos só em
 * AlertsService (alertas), nunca para login OTP.
 *
 * Throttle: 1 OTP/destinatário/60s (anti-abuso request-code).
 *
 * NOTA: classe mantém nome `WhatsappService` para evitar break de imports
 *       — o significado é "delivery de OTP via WhatsApp/Z-API".
 */

import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { SsmService } from "../common/ssm.service";
import { RedisService } from "../common/redis.service";

@Injectable()
export class WhatsappService {
  private readonly log = new Logger("WhatsApp");

  constructor(
    private readonly ssm: SsmService,
    private readonly redis: RedisService
  ) {}

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

  /**
   * Envia código OTP via WhatsApp/Z-API.
   *
   * O parâmetro `channel` é mantido por compatibilidade da assinatura
   * (já que controllers do auth ainda passam o valor), mas é ignorado
   * para OTP — sempre Z-API. Para SMS de alertas, usar AlertsService.
   */
  async sendOtp(
    phone: string,
    code: string,
    _channel: "whatsapp" | "sms" | "auto" = "auto"
  ): Promise<{ sent: boolean; provider: string; error?: string }> {
    const phoneClean = phone.replace(/\D/g, "");
    const phoneWith55 = phoneClean.startsWith("55") ? phoneClean : `55${phoneClean}`;

    // Throttle: 1 OTP/destinatário/minuto
    const throttleKey = `wa:otp:throttle:${phoneWith55}`;
    const lock = await this.redis.client
      .set(throttleKey, "1", "EX", 60, "NX")
      .catch(() => null);
    if (lock !== "OK") {
      this.log.warn(`OTP throttled for ${phoneWith55}`);
      return { sent: false, provider: "whatsapp-zapi", error: "throttled" };
    }

    // Rotaciona variantes (anti-fingerprint do WhatsApp/Z-API)
    const variants = [
      `🔐 *Controler NOC*\n\nCódigo de verificação: *${code}*\n\nNão compartilhe. Expira em 5min.`,
      `Controler NOC\n\nCódigo de verificação: ${code}\n\nExpira em 5 minutos.`,
      `Controler NOC ✅\n\nSeu código: *${code}*\n\nVálido por 5min.`
    ];
    const msg = variants[Math.floor(Math.random() * variants.length)];

    const result = await this.trySendZapi(phoneWith55, msg).catch((e) => ({
      sent: false,
      provider: "whatsapp-zapi",
      error: String(e?.message || e)
    }));
    if (!result.sent) {
      this.log.warn(`[OTP] canal Z-API falhou: ${result.error}`);
    }
    return result;
  }

  // ─── Canal WhatsApp Z-API (único ativo para OTP) ────────
  private async trySendZapi(
    phone: string,
    msg: string
  ): Promise<{ sent: boolean; provider: string; error?: string }> {
    try {
      const { instance, token, clientToken } = await this.credsZapi();
      const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (clientToken) headers["Client-Token"] = clientToken;
      const { data, status } = await axios.post(
        url,
        { phone, message: msg },
        { headers, timeout: 15_000, validateStatus: () => true }
      );
      if (status >= 400 || data?.error || !data?.messageId) {
        return {
          sent: false,
          provider: "whatsapp-zapi",
          error: `status=${status} ${JSON.stringify(data).slice(0, 150)}`
        };
      }
      this.log.log(`[WhatsApp/Z-API] OTP enviado phone=${phone} id=${data.messageId}`);
      return { sent: true, provider: "whatsapp-zapi" };
    } catch (err: any) {
      return { sent: false, provider: "whatsapp-zapi", error: err?.message };
    }
  }

  /**
   * Checa status da instância Z-API. Retorna { connected, raw }.
   * Usado pelo /be/auth/diagnostic para admin verificar saúde do canal.
   */
  async statusInstance(): Promise<{ connected: boolean; raw: unknown; error?: string }> {
    try {
      const { instance, token, clientToken } = await this.credsZapi();
      const headers: Record<string, string> = {};
      if (clientToken) headers["Client-Token"] = clientToken;
      const { data, status } = await axios.get(
        `https://api.z-api.io/instances/${instance}/token/${token}/status`,
        { headers, timeout: 10_000, validateStatus: () => true }
      );
      const connected =
        status === 200 && (data?.connected === true || data?.session === "CONNECTED");
      if (!connected) {
        this.log.warn(
          `[Z-API] instance NOT connected: status=${status} data=${JSON.stringify(data).slice(0, 200)}`
        );
      }
      return { connected, raw: data };
    } catch (err: any) {
      this.log.error(`[Z-API] status check failed: ${err?.message}`);
      return { connected: false, raw: null, error: err?.message };
    }
  }
}
