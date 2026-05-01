# Controler v3 — Prompts de Execução por Fase

> **Uso:** Cada bloco abaixo é um prompt autossuficiente para uma sessão de desenvolvimento.
> Contém todo o contexto necessário — sem depender de sessões anteriores.
> Executar na ordem: FASE 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7

---

## FASE 0 — Hotfixes de Segurança (BLOQUEANTE)

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Arquivo principal: controler.py (1609 linhas)
Stack: Python 3.12 + FastAPI + SQLite + React

MISSÃO: Aplicar 5 hotfixes de segurança críticos no controler.py. Nenhum outro
desenvolvimento pode acontecer antes dessas correções.

CORREÇÃO 1 — SEC-01: AGENT_API_TOKEN hardcoded (linha 56)
Linha atual:
  AGENT_API_TOKEN = os.getenv("AGENT_API_TOKEN", "openclaw_controler_2026")

Substituir por:
  def _load_agent_api_token() -> str:
      val = os.getenv("AGENT_API_TOKEN") or get_ssm_param("/controler/agent_api_token")
      if not val:
          raise RuntimeError("AGENT_API_TOKEN não configurado no SSM (/controler/agent_api_token)")
      return val
  AGENT_API_TOKEN = _load_agent_api_token()

CORREÇÃO 2 — SEC-03: Coolify token no path errado (linha 682)
Linha atual:
  _COOLIFY_TOKEN = os.getenv("COOLIFY_TOKEN") or get_ssm_param("/myclinicsoft/coolify_token") or ""

Substituir por:
  _COOLIFY_TOKEN = os.getenv("COOLIFY_TOKEN") or get_ssm_param("/controler/coolify_token") or ""

CORREÇÃO 3 — SEC-05: Senhas SSH em variáveis globais (linhas 690-694)
Linhas atuais:
  _SRV1_PASS   = get_ssm_param("/controler/srv1_ssh_password") or ""
  _FISIOMT_PASS        = get_ssm_param("/controler/fisiomt_ssh_password") or ""
  _FISIOMT_HESTIA_PASS = get_ssm_param("/controler/fisiomt_hestia_password") or ""

Substituir por lazy-load com functools.lru_cache (adicionar import no topo):
  import functools

  @functools.lru_cache(maxsize=None)
  def _get_srv1_pass() -> str:
      return get_ssm_param("/controler/srv1_ssh_password") or ""

  @functools.lru_cache(maxsize=None)
  def _get_fisiomt_pass() -> str:
      return get_ssm_param("/controler/fisiomt_ssh_password") or ""

  @functools.lru_cache(maxsize=None)
  def _get_fisiomt_hestia_pass() -> str:
      return get_ssm_param("/controler/fisiomt_hestia_password") or ""

  # Remover as 3 variáveis globais _SRV1_PASS, _FISIOMT_PASS, _FISIOMT_HESTIA_PASS
  # Atualizar todos os usos: _SRV1_PASS → _get_srv1_pass(), etc.
  # Buscar no arquivo: grep -n "_SRV1_PASS\|_FISIOMT_PASS\|_FISIOMT_HESTIA_PASS" controler.py

CORREÇÃO 4 — SEC-02: PROJECTS_PATH hardcoded (linhas 227, 559)
Linhas atuais (aparecem em múltiplos endpoints):
  dev_path = Path.home() / "Documents" / "DEV"

Adicionar no topo (após CONFIG = yaml.safe_load...):
  PROJECTS_PATH = Path(os.getenv("PROJECTS_PATH", str(Path.home() / "Documents" / "DEV")))

Substituir todas as ocorrências de:
  Path.home() / "Documents" / "DEV"
por:
  PROJECTS_PATH

CORREÇÃO 5 — SEC-08: Content Security Policy ausente (linha 92, middleware security_headers)
No middleware security_headers_middleware, adicionar ANTES do return response:
  response.headers["Content-Security-Policy"] = (
      "default-src 'self'; "
      "script-src 'self' 'unsafe-inline' fonts.googleapis.com cdnjs.cloudflare.com unpkg.com; "
      "style-src 'self' 'unsafe-inline' fonts.googleapis.com cdnjs.cloudflare.com; "
      "font-src 'self' fonts.gstatic.com; "
      "connect-src 'self'; "
      "img-src 'self' data:; "
      "frame-ancestors 'none';"
  )

APÓS TODAS AS CORREÇÕES:
1. python3 -m py_compile controler.py  → deve ser 0 erros
2. Verificar que não ficou nenhuma referência a "openclaw_controler_2026" no código
3. Verificar que não ficou nenhuma referência a "/myclinicsoft/coolify_token" (exceto em comentários)
4. Verificar que PROJECTS_PATH está sendo usado em todos os endpoints que antes usavam Path.home()

NÃO fazer deploy ainda. Fase 0 é só correção local.
```

---

## FASE 1 — Backend Modernization

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
A FASE 0 (hotfixes de segurança) já foi aplicada.
Arquivo principal: controler.py
Stack: Python 3.12 + FastAPI + SQLite + APScheduler

MISSÃO: Modernizar o backend com 4 objetivos principais.

OBJETIVO 1 — APScheduler para cron jobs nativos
Instalar: pip install apscheduler --break-system-packages

No lifespan (função lifespan em controler.py), adicionar inicialização do scheduler:
  from apscheduler.schedulers.asyncio import AsyncIOScheduler
  from apscheduler.triggers.interval import IntervalTrigger

  _scheduler = AsyncIOScheduler(timezone="America/Sao_Paulo")

  @asynccontextmanager
  async def lifespan(app):
      init_db()
      _seed_initial_data()
      _setup_schedulers()
      _scheduler.start()
      yield
      _scheduler.shutdown()

Criar função _setup_schedulers() com 4 jobs:
  - health_check_job: a cada 5 minutos → verifica containers via Docker socket
  - metrics_snapshot_job: a cada 2 minutos → salva CPU/RAM na tabela metrics_snapshots
  - deploy_sync_job: a cada 10 minutos → compara hash DEV/GIT/PROD
  - daily_digest_job: cron "0 8 * * *" BRT → prepara digest (implementar vazio por ora, completar na Fase 2)

OBJETIVO 2 — 5 novas tabelas SQLite
Abrir core/database.py e adicionar no init_db():

  CREATE TABLE IF NOT EXISTS timeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      project TEXT,
      title TEXT NOT NULL,
      detail TEXT,
      actor TEXT DEFAULT 'system',
      metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_timeline_ts ON timeline_events(ts DESC);

  CREATE TABLE IF NOT EXISTS metrics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      server TEXT NOT NULL DEFAULT 'srv1',
      container_name TEXT NOT NULL,
      cpu_percent REAL DEFAULT 0,
      mem_mb REAL DEFAULT 0,
      mem_percent REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_metrics_ts ON metrics_snapshots(ts DESC);

  CREATE TABLE IF NOT EXISTS alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT,
      channel TEXT NOT NULL,
      sent INTEGER DEFAULT 0,
      error TEXT
  );

  CREATE TABLE IF NOT EXISTS alert_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rule_name TEXT NOT NULL UNIQUE,
      enabled INTEGER DEFAULT 1,
      threshold REAL,
      cooldown_min INTEGER DEFAULT 30,
      min_severity TEXT DEFAULT 'warning'
  );

  CREATE TABLE IF NOT EXISTS deploy_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      project TEXT NOT NULL,
      status TEXT NOT NULL,
      triggered_by TEXT DEFAULT 'manual',
      commit_hash TEXT,
      duration_sec REAL,
      log_summary TEXT
  );

OBJETIVO 3 — Novos endpoints
Adicionar em controler.py:

  GET /api/timeline
    - Query params: project (str), severity (str), limit (int=50), offset (int=0)
    - Retorna: { events: [...], total: N }

  GET /api/metrics/history
    - Query params: container (str), hours (int=24)
    - Retorna: { snapshots: [...], container: str }

  GET /api/alerts
    - Retorna: { alerts: [...], active_count: N }

OBJETIVO 4 — Remover endpoint duplicado /api/containers (SSH legado)
Buscar em controler.py: @app.get("/api/containers")
Remover esse endpoint inteiro (usa SSH, duplicado de /api/server/docker/stats que usa socket)
Garantir que nenhum frontend ainda referencia /api/containers (buscar em static/)

APÓS TODAS AS MUDANÇAS:
1. python3 -m py_compile controler.py
2. python3 -m py_compile core/database.py
3. Verificar que as 5 tabelas são criadas sem erro rodando: python3 -c "from core.database import init_db; init_db(); print('OK')"
```

---

## FASE 2 — Alert System

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fases 0 e 1 já aplicadas.
APScheduler instalado e rodando. Tabelas alert_log e alert_config existem no SQLite.

MISSÃO: Implementar sistema de alertas completo — WhatsApp via Zapi + SMS API.

ARQUIVO A CRIAR: core/alerts.py

Estrutura obrigatória:

  import asyncio, httpx, logging, json
  from datetime import datetime, time
  from functools import lru_cache
  from core.ssm import get_ssm_param

  logger = logging.getLogger(__name__)

  # Configuração de canais
  ALERT_PHONE = "556598466555"  # 65-98466-5555 com DDI

  @lru_cache(maxsize=None)
  def _zapi_token():
      return get_ssm_param("/controler/zapi_token") or ""

  @lru_cache(maxsize=None)
  def _zapi_instance():
      return get_ssm_param("/controler/zapi_instance_id") or ""

  @lru_cache(maxsize=None)
  def _sms_api_key():
      return get_ssm_param("/controler/sms_api_key") or ""

  # Janela de silêncio: 22h–7h BRT (não envia alertas não-críticos nesse período)
  def _in_silence_window() -> bool:
      now_h = datetime.now().hour  # TODO: usar timezone BRT
      return now_h >= 22 or now_h < 7

  async def send_whatsapp(message: str, phone: str = ALERT_PHONE) -> bool:
      """Envia mensagem WhatsApp via Zapi API."""
      token = _zapi_token()
      instance = _zapi_instance()
      if not token or not instance:
          logger.warning("Zapi não configurado (SSM: /controler/zapi_token, /controler/zapi_instance_id)")
          return False
      try:
          async with httpx.AsyncClient(timeout=15) as client:
              r = await client.post(
                  f"https://api.z-api.io/instances/{instance}/token/{token}/send-text",
                  json={"phone": phone, "message": message}
              )
              return r.status_code == 200
      except Exception as e:
          logger.error(f"Zapi error: {e}")
          return False

  async def send_sms(message: str, phone: str = ALERT_PHONE) -> bool:
      """Envia SMS via Infobip (ou equivalente)."""
      api_key = _sms_api_key()
      if not api_key:
          logger.warning("SMS API não configurado (SSM: /controler/sms_api_key)")
          return False
      try:
          async with httpx.AsyncClient(timeout=15) as client:
              r = await client.post(
                  "https://api.infobip.com/sms/2/text/advanced",
                  headers={"Authorization": f"App {api_key}", "Content-Type": "application/json"},
                  json={"messages": [{"destinations": [{"to": phone}], "text": message, "from": "Controler"}]}
              )
              return r.status_code in (200, 201)
      except Exception as e:
          logger.error(f"SMS error: {e}")
          return False

  # ── AlertManager ────────────────────────────────────────────────────────────

  class AlertManager:
      """
      Roteamento de alertas por severidade:
        CRITICAL → WhatsApp + SMS (24/7)
        WARNING  → WhatsApp (fora da janela de silêncio)
        INFO     → apenas log local
      """
      def __init__(self):
          self._cooldown_cache: dict[str, datetime] = {}  # rule_key → último envio
          self.COOLDOWN_MINUTES = 30

      def _is_in_cooldown(self, rule_key: str) -> bool:
          last = self._cooldown_cache.get(rule_key)
          if not last:
              return False
          delta = (datetime.now() - last).total_seconds() / 60
          return delta < self.COOLDOWN_MINUTES

      def _mark_sent(self, rule_key: str):
          self._cooldown_cache[rule_key] = datetime.now()

      async def send(self, severity: str, title: str, body: str, rule_key: str = "") -> dict:
          """
          severity: 'critical' | 'warning' | 'info'
          rule_key: string única para controle de cooldown (ex: 'cpu_high_srv1')
          """
          severity = severity.lower()
          results = {"whatsapp": False, "sms": False, "skipped": False, "reason": ""}

          # Cooldown check
          if rule_key and self._is_in_cooldown(rule_key):
              results["skipped"] = True
              results["reason"] = f"cooldown ativo ({self.COOLDOWN_MINUTES}min)"
              return results

          msg = f"*[{severity.upper()}] {title}*\n{body}\n\n_{datetime.now().strftime('%d/%m %H:%M')}_"

          if severity == "critical":
              results["whatsapp"] = await send_whatsapp(msg)
              results["sms"] = await send_sms(f"[CRITICAL] {title}: {body}")
          elif severity == "warning":
              if _in_silence_window():
                  results["skipped"] = True
                  results["reason"] = "janela de silêncio (22h-7h)"
                  return results
              results["whatsapp"] = await send_whatsapp(msg)
          else:
              # INFO — apenas log
              logger.info(f"ALERT INFO: {title} — {body}")
              return results

          if rule_key:
              self._mark_sent(rule_key)

          # Persistir no banco
          _log_alert_db(severity, title, body, "whatsapp", results["whatsapp"])
          return results

  alert_manager = AlertManager()  # singleton

  def _log_alert_db(severity, title, body, channel, sent):
      """Salva alerta no SQLite (importar get_db_conn de core/database.py)."""
      try:
          from core.database import get_db_conn
          with get_db_conn() as conn:
              conn.execute(
                  "INSERT INTO alert_log (severity, title, body, channel, sent) VALUES (?,?,?,?,?)",
                  (severity, title, body, channel, 1 if sent else 0)
              )
      except Exception as e:
          logger.error(f"Falha ao salvar alert_log: {e}")

  async def send_daily_digest():
      """Digest diário — chamado pelo APScheduler às 8h BRT."""
      # Coletar dados básicos
      from core.database import get_db_conn
      try:
          with get_db_conn() as conn:
              alert_count = conn.execute(
                  "SELECT COUNT(*) FROM alert_log WHERE ts > datetime('now', '-1 day') AND sent=1"
              ).fetchone()[0]
          msg = (
              f"*Controler — Digest Diário* 📊\n"
              f"Hora: {datetime.now().strftime('%d/%m/%Y %H:%M')}\n"
              f"Alertas ontem: {alert_count}\n"
              f"Status: verificar dashboard\n"
              f"controler.net.br"
          )
          await send_whatsapp(msg)
      except Exception as e:
          logger.error(f"Falha no digest: {e}")

ENDPOINTS A ADICIONAR em controler.py:

  from core.alerts import alert_manager

  @app.post("/api/alerts/test")
  async def api_alerts_test(request: Request):
      body = await request.json()
      severity = body.get("severity", "warning")
      title = body.get("title", "Teste de alerta")
      msg = body.get("message", "Mensagem de teste do Controler")
      result = await alert_manager.send(severity, title, msg, rule_key="manual_test")
      return result

  @app.get("/api/alerts")
  async def api_alerts_list():
      # Lê últimos 100 alertas do banco
      ...implementar consultando alert_log...

TAMBÉM: No _setup_schedulers() da FASE 1, completar o daily_digest_job:
  from core.alerts import send_daily_digest
  _scheduler.add_job(send_daily_digest, CronTrigger(hour=8, minute=0, timezone="America/Sao_Paulo"), id="daily_digest")

VALIDAÇÃO FINAL:
1. python3 -m py_compile core/alerts.py → 0 erros
2. python3 -c "from core.alerts import AlertManager; print('OK')"
3. Verificar que não há chaves hardcoded no arquivo (nenhum token, nenhuma senha)
```

---

## FASE 3 — Frontend Architecture

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fases 0, 1, 2 aplicadas.
Frontend atual: React com Babel transpilation in-browser (static/index.html + static/app.js ou similar)
Objetivo: Substituir por arquitetura moderna com design system sci-fi, sem depender de Babel.

MISSÃO: Criar novo frontend usando Preact + HTM (sem build step, CDN) com design system sci-fi.

VERIFICAR PRIMEIRO: Listar todos os arquivos em static/:
  ls -la ~/Documents/DEV/controler/static/

ESTRATÉGIA: Preact + HTM via CDN (sem Node.js build step)
  - Preact via CDN: https://esm.sh/preact@10
  - HTM via CDN: https://esm.sh/htm@3
  - Mantém compatibilidade com o servidor FastAPI atual
  - Sem webpack, sem vite, sem node_modules no projeto Python

CRIAR: static/v3/index.html
  Estrutura base com:
  - CSS variables do design system sci-fi (tokens abaixo)
  - Import Preact + HTM via ESM CDN
  - Layout: sidebar fixa esquerda (240px) + main area
  - Hash-based router: window.location.hash → renderiza tela correspondente

CSS VARIABLES OBRIGATÓRIAS (inserir em :root):
  --cyan:    #00d4ff;
  --green:   #00e87a;
  --red:     #ff3366;
  --yellow:  #ffcc00;
  --purple:  #9945ff;
  --blue:    #2563eb;
  --bg:      #020308;
  --surface: #080c18;
  --surface2:#0d1625;
  --border:  #0d1f3c;
  --border2: #1a2f50;
  --text:    #e2e8f0;
  --muted:   #64748b;
  --glow-cyan: 0 0 20px rgba(0,212,255,0.3);
  --glow-green: 0 0 20px rgba(0,232,122,0.3);
  --glow-red: 0 0 20px rgba(255,51,102,0.3);

COMPONENTES BASE A CRIAR (em static/v3/components.js como módulo ES):

  1. StatusBadge({ status }) → span com cor semântica + pulse animation para "running"
  2. ProgressBar({ value, max, unit }) → barra com threshold automático (verde/amarelo/vermelho)
  3. GaugeCircle({ value, max, label }) → SVG circular estilo HUD
  4. SparkLine({ data, color }) → SVG path inline, sem lib externa
  5. TerminalLog({ lines, maxLines=100 }) → div monospace com auto-scroll
  6. StepTracker({ steps, currentStep }) → pipeline visual com N steps
  7. DrillCard({ title, value, subtitle, status, onClick }) → card clicável com hover glow

SIDEBAR navigation (hash routes):
  #/ → Mission Control (home)
  #/srv1 → srv1 Deep Dive
  #/projects/:name → Projeto
  #/openclaw → Agentes OpenClaw
  #/timeline → Timeline
  #/alerts → Alert Center
  #/vault → SSM Vault
  #/scanner → Resource Scanner

APÓS CRIAR static/v3/index.html:
  Testar abrindo http://localhost:3001/static/v3/index.html
  A página nova roda em paralelo com o frontend atual — não substituir ainda.
  Apenas confirmar que carrega sem erros no console.

ATENÇÃO: NÃO deletar static/index.html (frontend atual).
         A rota / ainda serve o index.html antigo até a FASE 4 estar completa.
```

---

## FASE 4 — Futuristic UI — Mission Control + srv1

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fases 0–3 aplicadas. Frontend novo em static/v3/index.html com componentes base.
Esta fase implementa as primeiras 3 telas principais.

MISSÃO: Implementar telas Mission Control, srv1 Deep Dive e FisioMT Panel.

TELA 1 — Mission Control (rota #/)
Layout: grid de cards para cada servidor + alert feed lateral

Seção esquerda (70%):
  - Header: "MISSION CONTROL" em --cyan com glow, subtítulo com hora atual (atualiza a cada segundo)
  - Card srv1: hostname, IP, uptime, CPU%, RAM%, status containers (dot verde/vermelho)
  - Card FisioMT: hostname, IP, uptime, status (via HestiaCP), serviços
  - Card OpenClaw: N agentes ativos / total, último cron, tokens hoje

Seção direita (30%):
  - "ALERT FEED" — últimos 10 alerts do /api/alerts (polling 30s)
  - Cada item: badge CRÍTICO/WARNING/INFO + título + timestamp relativo

Dados: GET /api/server/docker/stats → containers
       GET /api/alerts → feed
       GET /api/myclinicsoft/status → status MyClinicSoft

TELA 2 — srv1 Deep Dive (rota #/srv1)
Layout: header de hardware + grid de containers

Header hardware (faixa superior):
  - GaugeCircle CPU total (soma containers)
  - GaugeCircle RAM total
  - Disco: ProgressBar com valor em GB
  - Uptime do servidor

Container Grid (abaixo):
  - Um DrillCard por container
  - Cada card: nome, status badge, cpu%, mem%, net I/O
  - Clicar → abre painel lateral (drawer) com:
      * Logs ao vivo (TerminalLog via GET /api/server/containers/{id}/logs)
      * Botão Restart
      * Env vars (mascaradas)

Dados: GET /api/server/docker/stats (polling 5s)
       GET /api/server/coolify/applications

TELA 3 — FisioMT Panel (rota #/fisiomt)
Layout: header de status + lista de contas

Header:
  - Status da conexão SSH/HestiaCP
  - Versão HestiaCP, hostname

Tabela de contas (GET /api/vps-fisiomt/hestia/accounts):
  - Coluna: user, plano, status, web, mail, db, disco%
  - Linha clicável → expande domínios do usuário

INTEGRAÇÃO COM SERVIDOR:
  - Todos os fetch() usam: fetch('/api/...')
  - Headers de autenticação não necessários (middleware Basic Auth cuida disso)
  - Para polling: usar setInterval (sem libs)
  - Para logs ao vivo: EventSource para SSE quando disponível

CUTOVER: Quando as 3 telas estiverem prontas e funcionando:
  - Atualizar em controler.py a rota @app.get("/") para servir static/v3/index.html
  - TESTAR localmente antes de commitar
```

---

## FASE 4B — Futuristic UI — Deploy Pipeline + Timeline + Alerts

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fase 4 concluída (Mission Control, srv1, FisioMT prontos).
Esta fase implementa as telas de Deploy, Timeline e Alert Center.

MISSÃO: Implementar telas Deploy Pipeline, Timeline e Alert Center.

TELA 4 — Deploy Pipeline (rota #/deploy/:project)
Componente central: StepTracker com 9 steps:
  1. TypeScript Check (npx tsc --noEmit)
  2. Build local
  3. Git add + commit
  4. Git push → GitHub
  5. Coolify detected push
  6. Coolify building
  7. Container replacing
  8. Health check
  9. ✅ Live

Painel SSE: GET /api/myclinicsoft/deploy/stream → exibe linhas no TerminalLog em tempo real
Botão de deploy: POST → inicia o stream

Sidebar de histórico:
  - Lista últimos 10 deploys da tabela deploy_history
  - Status badge + timestamp + duração

TELA 5 — Timeline (rota #/timeline)
Layout inspirado no GitHub Activity Feed

Filtros no topo: All / Deploy / Alert / Restart / Config
Cada evento:
  - Dot colorido por severidade na linha do tempo vertical
  - Título, projeto, detalhe
  - Timestamp relativo ("há 3 minutos") + absoluto no hover

Dados: GET /api/timeline?limit=100
Polling: a cada 30 segundos

TELA 6 — Alert Center (rota #/alerts)
Seção superior — Alertas Ativos:
  - Card por alerta ativo, badge CRÍTICO/WARNING
  - Botão "Reconhecer" → muda status

Seção inferior — Configuração de Thresholds:
  - Tabela editável das regras em alert_config
  - Toggle enabled/disabled por regra
  - Input de threshold
  - Botão "Testar" → POST /api/alerts/test

Seção de histórico:
  - Últimos 50 alertas enviados da tabela alert_log
  - Coluna: canal (WhatsApp/SMS), sent (✓/✗), timestamp
```

---

## FASE 4C — Futuristic UI — Vault + OpenClaw + Projects

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fases 4 e 4B concluídas.
Esta fase finaliza as últimas telas.

MISSÃO: Implementar Vault (SSM), OpenClaw Console e Project Overview.

TELA 7 — Vault / SSM (rota #/vault)
Conceito: "cofre" de credenciais com interface minimalista

Agrupamento por prefixo SSM:
  /controler/*       → grupo "Controler"
  /myclinicsoft/*    → grupo "MyClinicSoft"
  /libertakidz/*     → grupo "LibertaKidz"

Cada parâmetro:
  - Nome (sem o prefixo do grupo)
  - Tipo (String / SecureString)
  - Data da última modificação
  - Valor MASCARADO: "••••••••" + botão olho → POST /api/credentials/{id}/reveal
  - Status: verde se existe, vermelho se ausente

Dados: GET /api/credentials (endpoint existente)

TELA 8 — OpenClaw Console (rota #/openclaw)
Grid 2×2 — um card por agente (myclinicsoft, xospam, libertakidz, controler):
  - Header do card: ícone + nome + StatusBadge (running/stopped)
  - Modelo primário configurado
  - Número de cron jobs
  - Tokens hoje (do log de uso)

Expandir card → ver cron jobs:
  - Tabela: nome, schedule, último status, último run, próximo run
  - Botão "Run agora" → POST para executar manualmente

Dados: GET /api/server/openclaw/agents

TELA 9 — Project Overview (rota #/projects/:name)
Seção 1 — Deploy Status:
  - Sync DEV/GIT/PROD: 3 badges com hash e status (synced/out-of-sync)
  - Último commit: mensagem + autor + timestamp

Seção 2 — Container:
  - Status do container do projeto (link para srv1)
  - CPU%, RAM%, uptime

Seção 3 — Memories:
  - Contagem por tipo (context, rule, decision, etc.)
  - Timeline das últimas entradas

Seção 4 — Rules:
  - Lista de regras do projeto
  - Cada regra: categoria + título + severidade (mandatory/info)

Botão de Deploy: inicia pipeline → redireciona para #/deploy/:project

CUTOVER FINAL:
  Quando todas as telas estiverem completas:
  1. Testar todas as rotas no browser
  2. Verificar que não há erros no console
  3. Atualizar @app.get("/") → static/v3/index.html (se não feito na Fase 4)
```

---

## FASE 5 — Resource Scanner

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fases 0–4C concluídas. Frontend v3 ativo.

MISSÃO: Implementar o Resource Scanner — feature que detecta recursos desperdiçados.

ARQUIVO A CRIAR: core/scanner.py

Categorias de scan:

  1. CONTAINERS PARADOS (via Docker socket)
     - Lista containers com state != "running"
     - Para cada um: nome, imagem, último start, tempo parado
     - Sugestão: "docker rm {container_id}"
     - Severidade: WARNING se > 7 dias, INFO se < 7 dias

  2. DOCKER IMAGES DANGLING
     - GET /images/json?filters={"dangling":["true"]} via Docker socket
     - Calcula espaço total em MB
     - Sugestão: "docker image prune -f"

  3. DOCKER VOLUMES SEM USO
     - GET /volumes?filters={"dangling":["true"]} via Docker socket
     - Sugestão: "docker volume prune -f"

  4. GIT BRANCHES ANTIGAS (verificar projetos em PROJECTS_PATH)
     - Para cada projeto: git branch -r --merged main
     - Branches sem commit há > 30 dias
     - Sugestão: "git branch -d {branch}"

  5. SSM PARAMS SEM REFERÊNCIA
     - Lista todos os parâmetros /controler/* do SSM
     - Compara com os nomes usados em controler.py (via grep ou lista hardcoded)
     - Parâmetros no SSM que não aparecem no código: suspeitos
     - Severidade: INFO (requer revisão manual)

  6. CRONS COM 100% ERRO
     - Busca na tabela timeline_events: event_type='cron_run', status='error'
     - Agrupa por job_id, calcula taxa de erro dos últimos 30 dias
     - Jobs com > 90% erro: severidade WARNING

ESTRUTURA DO RESULTADO:
  {
    "scanned_at": "ISO timestamp",
    "items": [
      {
        "category": "containers | images | volumes | git | ssm | crons",
        "severity": "critical | warning | info",
        "title": "string",
        "description": "string",
        "action": "string — comando sugerido",
        "action_safe": true/false,  # true = pode executar automaticamente
        "metadata": {}
      }
    ],
    "summary": {
      "critical": N,
      "warning": N,
      "info": N,
      "total": N
    }
  }

ENDPOINT A ADICIONAR em controler.py:
  GET /api/scanner/run → executa scan completo (pode demorar ~10s)
  GET /api/scanner/last → retorna último resultado cacheado

AÇÃO DE CORREÇÃO (para items com action_safe=true):
  POST /api/scanner/fix
  Body: { "category": "images", "action": "docker image prune -f" }
  → Executa via subprocess com whitelist de comandos permitidos
  → Retorna: { "executed": bool, "output": str, "error": str }
  IMPORTANTE: Whitelist OBRIGATÓRIA — apenas comandos seguros pré-aprovados

TELA 10 — Scanner (rota #/scanner) — atualizar frontend v3:
  Botão "Executar Scanner" → loading spinner → exibe resultados
  Agrupamento por categoria com ícones
  Card por item: badge severidade + título + descrição + botão "Corrigir" (se action_safe)
  Após "Corrigir": re-executa scanner automaticamente
  Último scan: timestamp + botão refresh

VALIDAÇÃO:
  1. python3 -m py_compile core/scanner.py
  2. python3 -c "import asyncio; from core.scanner import run_scan; asyncio.run(run_scan())"
```

---

## FASE 6 — Polish, Mobile e Deploy

```
CONTEXTO:
Projeto: Controler (~/Documents/DEV/controler/)
Fases 0–5 concluídas. Frontend v3 completo e funcional.

MISSÃO: Polimento final, responsividade mobile e deploy em produção.

PARTE 1 — Responsividade Mobile (static/v3/index.html)

Media queries obrigatórias:
  @media (max-width: 768px) {
    .sidebar { width: 60px; } /* colapsa para ícones */
    .sidebar .nav-label { display: none; }
    .main { margin-left: 60px; }
    .card-grid { grid-template-columns: 1fr; }
  }

Touch targets: todos os botões e itens clicáveis devem ter min-height: 48px
Sidebar mobile: swipe left fecha, hamburger menu abre

PARTE 2 — Keyboard Shortcuts
  Cmd+K → abre Global Search (input flutuante com fuzzy search em containers, projetos, SSM)
  Esc → fecha modal/drawer aberto
  G+H → goto Home (#/)
  G+S → goto srv1 (#/srv1)
  G+T → goto Timeline (#/timeline)
  G+A → goto Alerts (#/alerts)

Implementar: document.addEventListener('keydown', handler)

PARTE 3 — Loading Skeletons
Para cada tela, enquanto fetch() está pendente:
  - Mostrar placeholder com background animado (CSS animation shimmer)
  - Substituir pelo dado real quando chegue
  - Evitar layout shift (manter dimensões dos cards durante loading)

PARTE 4 — Deploy em Produção

4.1 — Variáveis de ambiente no Coolify:
  Adicionar via API do Coolify (não via UI — evitar DecryptException):

  curl -X PATCH "http://62.72.63.18:8000/api/v1/applications/hksw4kg8owgs0wwg0o8k4kk0/envs/bulk" \
    -H "Authorization: Bearer $COOLIFY_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"data": [{"key": "PROJECTS_PATH", "value": "/projects", "is_secret": false}]}'

4.2 — Volume Docker no Coolify:
  Adicionar volume: ~/Documents/DEV → /projects (read-only)
  Isso corrige o SEC-02 (dashboard zerado em produção)

4.3 — Sequência de deploy:
  cd ~/Documents/DEV/controler
  python3 -m py_compile controler.py
  git add -A
  git commit -m "feat(v3): Controler Command Center v3 - modernização completa"
  git push origin main
  # Acionar Coolify:
  curl -X POST "http://62.72.63.18:8000/api/v1/applications/hksw4kg8owgs0wwg0o8k4kk0/restart" \
    -H "Authorization: Bearer $COOLIFY_TOKEN"

4.4 — Verificação pós-deploy:
  curl -s https://controler.net.br/api/health
  # Esperar: {"status":"ok","service":"controler","version":"3.0.0"}

PARTE 5 — Atualizar versão e documentação
  - controler.py: version="2.0.0" → version="3.0.0"
  - Criar CHANGELOG.md com resumo das mudanças v3
  - Atualizar CLAUDE.md do projeto com novos endpoints e estrutura

VALIDAÇÃO FINAL:
  1. Abrir https://controler.net.br no mobile e desktop
  2. Verificar que todos os KPIs aparecem (não zerados)
  3. Testar POST /api/alerts/test com severity=warning → receber WhatsApp
  4. Testar deploy via UI → StepTracker animado
  5. Executar Scanner → ao menos 1 resultado
```

---

## CHECKPOINT — Após cada fase

```
Executar após completar qualquer fase:

1. VERIFICAÇÃO DE SINTAXE:
   python3 -m py_compile controler.py
   python3 -m py_compile core/database.py
   [python3 -m py_compile core/alerts.py]  — se existir
   [python3 -m py_compile core/scanner.py] — se existir

2. VERIFICAÇÃO DE SEGREDOS:
   grep -rn "openclaw_controler_2026\|/myclinicsoft/coolify_token" \
     --include="*.py" ~/Documents/DEV/controler/
   # Deve retornar 0 linhas

3. GIT STATUS:
   git -C ~/Documents/DEV/controler status
   git -C ~/Documents/DEV/controler diff --stat

4. REGISTRAR NO PLANEJAMENTO.md:
   Adicionar linha "✅ FASE X concluída — [data] — [resumo do que foi feito]"
   no arquivo ~/Documents/DEV/controler/PLANEJAMENTO.md
```
