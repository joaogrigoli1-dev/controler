"""
core/alerts.py — Sistema de alertas do Controler v3
====================================================
Canais suportados:
  - WhatsApp via Zapi API
  - SMS via Infobip

Roteamento por severidade:
  CRITICAL → WhatsApp + SMS (24/7, sem janela de silêncio)
  WARNING  → WhatsApp (respeitando janela de silêncio 22h-7h BRT)
  INFO     → apenas log local

Todos os tokens/secrets vêm do AWS SSM Parameter Store — nunca hardcoded.
"""

import asyncio
import logging
from datetime import datetime
from functools import lru_cache

import httpx

from core.ssm import get_ssm_param

logger = logging.getLogger(__name__)

# ── Número de destino dos alertas ───────────────────────────────────────────
ALERT_PHONE = "556598466555"  # 65-98466-5555 (João Henrique, MT → 12 dígitos)


# ── SSM secrets (lazy-loaded, cached) ───────────────────────────────────────

@lru_cache(maxsize=None)
def _zapi_token() -> str:
    return get_ssm_param("/controler/zapi_token") or ""


@lru_cache(maxsize=None)
def _zapi_instance() -> str:
    return get_ssm_param("/controler/zapi_instance_id") or ""


@lru_cache(maxsize=None)
def _sms_api_key() -> str:
    return get_ssm_param("/controler/sms_api_key") or ""


# ── Janela de silêncio 22h-7h BRT ───────────────────────────────────────────

def _in_silence_window() -> bool:
    """Retorna True se estamos no período de silêncio (22h-7h).
    Alertas WARNING não são enviados nesse período; CRITICAL sempre envia."""
    hour = datetime.now().hour  # hora local do servidor (configurado para BRT via APScheduler)
    return hour >= 22 or hour < 7


# ── Envio via Zapi (WhatsApp) ────────────────────────────────────────────────

async def send_whatsapp(message: str, phone: str = ALERT_PHONE) -> bool:
    """
    Envia mensagem WhatsApp via Zapi API.
    Docs: https://developer.z-api.io/message/send-text

    Retorna True se enviou com sucesso, False em qualquer falha.
    """
    token = _zapi_token()
    instance = _zapi_instance()

    if not token or not instance:
        logger.warning(
            "Zapi não configurado — configure os parâmetros SSM: "
            "/controler/zapi_token e /controler/zapi_instance_id"
        )
        return False

    url = f"https://api.z-api.io/instances/{instance}/token/{token}/send-text"
    payload = {"phone": phone, "message": message}

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(url, json=payload)
            if response.status_code == 200:
                logger.info(f"WhatsApp enviado para {phone[:6]}***")
                return True
            else:
                logger.error(
                    f"Zapi retornou HTTP {response.status_code}: {response.text[:200]}"
                )
                return False
    except httpx.TimeoutException:
        logger.error("Zapi timeout após 15s")
        return False
    except Exception as exc:
        logger.error(f"Zapi erro inesperado: {exc}")
        return False


# ── Envio via SMS (Infobip) ──────────────────────────────────────────────────

async def send_sms(message: str, phone: str = ALERT_PHONE) -> bool:
    """
    Envia SMS via Infobip.
    Docs: https://www.infobip.com/docs/api/channels/sms

    Retorna True se enviou com sucesso, False em qualquer falha.
    """
    api_key = _sms_api_key()

    if not api_key:
        logger.warning(
            "SMS API não configurado — configure o parâmetro SSM: /controler/sms_api_key"
        )
        return False

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                "https://api.infobip.com/sms/2/text/advanced",
                headers={
                    "Authorization": f"App {api_key}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
                json={
                    "messages": [
                        {
                            "destinations": [{"to": phone}],
                            "text": message[:160],  # SMS limit
                            "from": "Controler",
                        }
                    ]
                },
            )
            if response.status_code in (200, 201):
                logger.info(f"SMS enviado para {phone[:6]}***")
                return True
            else:
                logger.error(
                    f"Infobip retornou HTTP {response.status_code}: {response.text[:200]}"
                )
                return False
    except httpx.TimeoutException:
        logger.error("Infobip timeout após 15s")
        return False
    except Exception as exc:
        logger.error(f"SMS erro inesperado: {exc}")
        return False


# ── Persistência no banco ────────────────────────────────────────────────────

def _log_alert_db(
    severity: str,
    title: str,
    body: str,
    channel: str,
    sent: bool,
    error: str | None = None,
) -> None:
    """Persiste alerta no SQLite (tabela alert_log)."""
    try:
        from core.database import get_db_conn

        with get_db_conn() as conn:
            conn.execute(
                "INSERT INTO alert_log (severity, title, body, channel, sent, error) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (severity, title, body[:500], channel, 1 if sent else 0, error),
            )
    except Exception as exc:
        logger.error(f"Falha ao persistir alert_log: {exc}")


# ── AlertManager ─────────────────────────────────────────────────────────────

class AlertManager:
    """
    Gerenciador central de alertas do Controler.

    Fluxo de decisão para cada alerta:
      1. Cooldown check (evita spam de alertas repetidos)
      2. Janela de silêncio (apenas WARNING é afetado)
      3. Roteamento por severidade:
           CRITICAL → WhatsApp + SMS
           WARNING  → WhatsApp
           INFO     → somente log
      4. Persistência no SQLite (alert_log)
    """

    COOLDOWN_MINUTES = 30

    def __init__(self) -> None:
        # rule_key → datetime do último envio
        self._cooldown_cache: dict[str, datetime] = {}

    # ── cooldown helpers ─────────────────────────────────────────────────────

    def _is_in_cooldown(self, rule_key: str) -> bool:
        last = self._cooldown_cache.get(rule_key)
        if not last:
            return False
        elapsed_min = (datetime.now() - last).total_seconds() / 60
        return elapsed_min < self.COOLDOWN_MINUTES

    def _mark_sent(self, rule_key: str) -> None:
        self._cooldown_cache[rule_key] = datetime.now()

    # ── public API ───────────────────────────────────────────────────────────

    async def send(
        self,
        severity: str,
        title: str,
        body: str,
        rule_key: str = "",
    ) -> dict:
        """
        Envia alerta conforme severidade.

        Args:
            severity: 'critical' | 'warning' | 'info'
            title:    Título curto (aparece em negrito no WhatsApp)
            body:     Corpo da mensagem
            rule_key: String única para cooldown (ex: 'cpu_high_srv1').
                      Se vazio, cooldown não é aplicado.

        Returns:
            dict com chaves: whatsapp (bool), sms (bool), skipped (bool), reason (str)
        """
        severity = severity.lower()
        result: dict = {
            "whatsapp": False,
            "sms": False,
            "skipped": False,
            "reason": "",
        }

        # 1. Cooldown check
        if rule_key and self._is_in_cooldown(rule_key):
            result["skipped"] = True
            result["reason"] = f"cooldown ativo ({self.COOLDOWN_MINUTES}min)"
            logger.debug(f"Alerta '{title}' bloqueado por cooldown (rule_key={rule_key})")
            return result

        # 2. Formatar mensagem WhatsApp (markdown Zapi)
        ts = datetime.now().strftime("%d/%m %H:%M")
        wapp_msg = f"*[{severity.upper()}] {title}*\n{body}\n\n_{ts} — Controler v3_"

        # 3. Roteamento por severidade
        if severity == "critical":
            # CRITICAL → WhatsApp + SMS, sem janela de silêncio
            result["whatsapp"] = await send_whatsapp(wapp_msg)
            sms_text = f"[CRITICAL] {title}: {body}"
            result["sms"] = await send_sms(sms_text)

        elif severity == "warning":
            # WARNING → WhatsApp, respeitando janela de silêncio
            if _in_silence_window():
                result["skipped"] = True
                result["reason"] = "janela de silêncio (22h-7h BRT)"
                logger.info(f"Alerta WARNING '{title}' suprimido (silêncio noturno)")
                return result
            result["whatsapp"] = await send_whatsapp(wapp_msg)

        else:
            # INFO → somente log local
            logger.info(f"ALERT INFO — {title}: {body}")
            return result

        # 4. Marcar cooldown + persistir
        if rule_key:
            self._mark_sent(rule_key)

        channel = "whatsapp+sms" if severity == "critical" else "whatsapp"
        success = result["whatsapp"] or result["sms"]
        _log_alert_db(
            severity=severity,
            title=title,
            body=body,
            channel=channel,
            sent=success,
            error=None if success else "falha no envio",
        )

        return result

    def get_cooldown_status(self) -> list[dict]:
        """Retorna status do cooldown de todas as regras ativas."""
        now = datetime.now()
        return [
            {
                "rule_key": key,
                "last_sent": last.isoformat(),
                "remaining_min": max(
                    0,
                    round(self.COOLDOWN_MINUTES - (now - last).total_seconds() / 60, 1),
                ),
            }
            for key, last in self._cooldown_cache.items()
        ]


# ── Singleton global ─────────────────────────────────────────────────────────
alert_manager = AlertManager()


# ── Digest diário ─────────────────────────────────────────────────────────────

async def send_daily_digest() -> None:
    """
    Digest diário enviado às 8h BRT via APScheduler.
    Resume as últimas 24h: alertas, deploys, saúde dos containers.
    """
    from core.database import get_db_conn

    try:
        with get_db_conn() as conn:
            alert_count = conn.execute(
                "SELECT COUNT(*) FROM alert_log "
                "WHERE ts > datetime('now', '-1 day') AND sent = 1"
            ).fetchone()[0]

            critical_count = conn.execute(
                "SELECT COUNT(*) FROM alert_log "
                "WHERE ts > datetime('now', '-1 day') AND severity = 'critical' AND sent = 1"
            ).fetchone()[0]

            deploy_count = conn.execute(
                "SELECT COUNT(*) FROM deploy_history "
                "WHERE ts > datetime('now', '-1 day')"
            ).fetchone()[0]

            deploy_ok = conn.execute(
                "SELECT COUNT(*) FROM deploy_history "
                "WHERE ts > datetime('now', '-1 day') AND status = 'success'"
            ).fetchone()[0]

        status_icon = "✅" if critical_count == 0 else "⚠️"
        ts = datetime.now().strftime("%d/%m/%Y %H:%M")

        msg = (
            f"*Controler — Digest Diário* {status_icon}\n"
            f"📅 {ts} (BRT)\n\n"
            f"• Alertas últimas 24h: {alert_count} ({critical_count} críticos)\n"
            f"• Deploys: {deploy_ok}/{deploy_count} com sucesso\n\n"
            f"🔗 Dashboard: controler.net.br"
        )

        await send_whatsapp(msg)
        logger.info(f"Daily digest enviado: {alert_count} alertas, {deploy_count} deploys")

    except Exception as exc:
        logger.error(f"Falha no daily digest: {exc}")
