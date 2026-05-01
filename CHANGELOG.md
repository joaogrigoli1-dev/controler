# Changelog — Controler Command Center

Todas as mudanças notáveis deste projeto seguem o formato [Keep a Changelog](https://keepachangelog.com/pt-BR/1.0.0/).

---

## [3.0.0] — 2026-05-01

### Resumo
Refatoração completa — de dashboard local com Babel inline para Command Center v3 com frontend Preact sci-fi, backend APScheduler nativo, sistema de alertas WhatsApp/SMS, Resource Scanner e deploy triangulado em produção.

---

### Segurança
- **SEC-01** `AGENT_API_TOKEN` movido para AWS SSM `/controler/agent_api_token` — removido hardcode `'openclaw_controler_2026'`; RuntimeError se ausente
- **SEC-02** `PROJECTS_PATH` configurável via env var — resolve dashboard zerado em Docker (antes hardcoded para `~/Documents/DEV`)
- **SEC-03** Coolify token lido de `/controler/coolify_token` (antes cruzava com `/myclinicsoft/coolify_token`)
- **SEC-04** Senhas SSH carregadas com `@functools.lru_cache` via SSM em vez de variáveis globais no startup
- **SEC-08** Content-Security-Policy adicionado: `script-src`, `connect-src 'self' https://esm.sh`, `frame-ancestors 'none'`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`

### Backend
- **APScheduler** `AsyncIOScheduler` com 4 jobs nativos:
  - `metrics_snapshot` — snapshots de CPU/RAM a cada 2 minutos
  - `health_check` — checagem de saúde dos containers a cada 5 minutos
  - `deploy_sync` — sincronização DEV/GIT/PROD a cada 10 minutos
  - `daily_digest` — digest diário via WhatsApp às 8h BRT
- **5 novas tabelas SQLite**: `timeline_events`, `metrics_snapshots`, `alert_log`, `alert_config`, `deploy_history`
- **Novos endpoints**:
  - `GET /api/timeline` — feed cronológico de eventos
  - `GET /api/metrics/history` — histórico de snapshots CPU/RAM
  - `GET /api/metrics/containers` — métricas por container
  - `GET /api/alerts` — log de alertas enviados
  - `POST /api/alerts/test` — disparo manual de alerta
  - `GET /api/deploy/history` — histórico de deploys
  - `GET /api/scheduler/jobs` — status dos jobs APScheduler
  - `GET /api/scanner/run` — executar Resource Scanner
  - `GET /api/scanner/last` — último resultado do scanner
  - `POST /api/scanner/fix` — executar ação segura sugerida pelo scanner
  - `GET /api/openclaw/agents` — status dos agentes OpenClaw
  - `GET /api/openclaw/agents/{id}/logs` — logs de um agente
  - `GET /api/vault/params` — parâmetros SSM agrupados por prefix
- **Root `/`** serve v3 `static/v3/index.html` com fallback para v2

### Alert System (`core/alerts.py`)
- `AlertManager` com cooldown de 30 minutos por `rule_key`
- Janela de silêncio automática 22h–7h BRT (apenas `CRITICAL` passa)
- `CRITICAL` → WhatsApp (Zapi) + SMS (Infobip) — 24/7
- `WARNING` → WhatsApp — respeita janela de silêncio
- `INFO` → log interno apenas
- Target fixo: `556598466555`
- Credenciais via SSM: `/controler/zapi_token`, `/controler/zapi_instance_id`
- `send_daily_digest()` — resumo às 8h BRT com status do sistema

### Resource Scanner (`core/scanner.py`)
- `scan_stopped_containers()` — containers parados há > 7 dias → WARNING
- `scan_dangling_images()` — images Docker sem tag/container → sugestão de prune
- `scan_dangling_volumes()` — volumes sem container montado
- `scan_git_branches()` — branches merged em main há > 30 dias
- `scan_ssm_params()` — parâmetros SSM sem referência no código
- `scan_failing_crons()` — jobs com > 90% erro nos últimos 30 dias
- `execute_safe_action()` — executa APENAS comandos da `SAFE_COMMANDS_WHITELIST`
- Resultado estruturado com `severity`, `action`, `action_safe`, `metadata`

### Frontend (Preact + HTM ESM)
- **Zero build step** — Preact + HTM via `https://esm.sh` CDN com `<script type="module">`
- **Design system sci-fi** — 10 tokens CSS: `--cyan #00d4ff`, `--green #00e87a`, `--red #ff3366`, `--yellow #ffcc00`, `--purple #9945ff`, `--bg #020308` e mais
- **Hash-based router** — lazy `import('./screens/${name}.js')` por rota
- **Sidebar** com 9 rotas: `/`, `/srv1`, `/fisiomt`, `/projects`, `/openclaw`, `/scanner`, `/timeline`, `/alerts`, `/vault`
- **Skeleton loading** — animação CSS para estados de carregamento
- **Keyboard shortcuts**: `Cmd+K` abre busca global; `G+H/S/T/A/V/P` para navegação rápida; `Esc` fecha overlay
- **Mobile responsive**: media queries em 1200/900/768/640/480px; hamburger menu colapsável; touch-friendly

### Componentes (`static/v3/components.js`)
- `StatusBadge` — badge semântico com pulse animation
- `ProgressBar` — barra com threshold colors automáticos
- `GaugeCircle` — medidor circular estilo HUD animado
- `SparkLine` — gráfico sparkline inline sem dependências
- `TerminalLog` — visor de logs monospace com scroll automático
- `StepTracker` — rastreador de passos para pipelines
- `DrillCard` — card clicável com hover state e chevron

### Telas (`static/v3/screens/`)
- `mission-control.js` — Home: KPIs globais, métricas, containers, timeline recente
- `srv1.js` — srv1 Deep Dive: gauges CPU/RAM/disco, tabela de containers com restart
- `fisiomt.js` — FisioMT Panel: stats VPS + contas HestiaCP com domínios expandíveis
- `projects.js` — Projetos: cards com status de deploy e histórico
- `openclaw.js` — OpenClaw: jobs APScheduler + agentes com TerminalLog
- `scanner.js` — Resource Scanner: botão executar, resultados por categoria
- `timeline.js` — Timeline: feed paginado com filtro por severidade
- `alerts.js` — Alert Center: log de alertas + painel de teste
- `vault.js` — Vault SSM: parâmetros agrupados por prefix com reveal toggle

### Infraestrutura
- `requirements.txt` — adicionado `apscheduler>=3.10.0`
- `PROJECTS_PATH=/projects` configurado no Coolify via API
- Deploy em produção `https://controler.net.br` com health check `version: 3.0.0`

---

## [2.0.0] — 2026-04 (anterior)

Dashboard operacional com React inline + Babel transpilation. Funcionalidades básicas de KPI, containers via Docker socket, integração FisioMT/HestiaCP, SSM credentials viewer, Basic Auth.

---

## [1.0.0] — 2025 (inicial)

Versão inicial do Controler como ferramenta de automação Python local com scripts de deploy e monitoramento básico.
