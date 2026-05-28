/**
 * WhatsappService — envio de OTP via Z-API.
 * Espelho simplificado do `sendOtpMessage` do MyClinicSoft (kind="otp", bypass kill-switch).
 *
 * Decisão João (25/05/2026): Z-API é a ROTA PRINCIPAL de OTP enquanto Meta
 * bloqueia o template otp_sms_whats. Aqui aplicamos:
 *   - dedup curto (60s)
 *   - throttle por destinatário (1 OTP/min)
 *   - variação leve de texto
 *
 * Em prod (v4.1) este service vai virar wrapper sobre `zapi-guard.ts` portado.
 */

import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { SsmService } from "../common/ssm.service";
import { RedisService } from "../common/redis.service";

@Injectable()
export class WhatsappService {
  private readonly log = new Logger("WhatsApp");

  constructor(private readonly ssm: SsmService, private readonly redis: RedisService) {}

  private async creds() {
    const instance =
      process.env.ZAPI_INSTANCE_ID ||
      (await this.ssm.get("/controler/zapi_instance_id")) ||
      (await this.ssm.get("/myclinicsoft/zapi_instance_id"));
    const token =
      process.env.ZAPI_TOKEN ||
      (await this.ssm.get("/controler/zapi_token")) ||
      (await this.ssm.get("/myclinicsoft/zapi_token"));
    const clientToken =
      process.env.ZAPI_CLIENT_TOKEN ||
      (await this.ssm.get("/myclinicsoft/zapi_client_token"));
    if (!instance || !token) throw new Error("Z-API instance/token não configurados");
    return { instance, token, clientToken };
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

    try {
      const { instance, token, clientToken } = await this.creds();
      const url = `https://api.z-api.io/instances/${instance}/token/${token}/send-text`;
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (clientToken) headers["Client-Token"] = clientToken;

      const { data } = await axios.post(url, { phone: phoneWith55, message: msg }, { headers, timeout: 15_000 });
      this.log.log(`OTP sent via Z-API to ${phoneWith55} (id=${data?.messageId || "?"})`);
      return { sent: true, provider: "zapi" };
    } catch (err: any) {
      this.log.error(`Z-API send failed for ${phoneWith55}: ${err?.message}`);
      return { sent: false, provider: "zapi", error: err?.message };
    }
  }
}
