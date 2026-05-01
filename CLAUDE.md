# CLAUDE.md — controler v3

## Sobre o projeto

**controler** — Command Center operacional para toda a infraestrutura de desenvolvimento.

**Localização:** `~/Documents/DEV/controler/`  
**Produção:** `https://controler.net.br` (Basic Auth protegido)  
**Versão atual:** `3.0.0`

---

## Stack

- **Backend:** Python 3.12 + FastAPI + SQLite + APScheduler
- **Frontend:** Preact 10 + HTM via `https://esm.sh` — zero build step
- **Infra:** Docker socket + AWS SSM + Coolify (UUID `hksw4kg8owgs0wwg0o8k4kk0`) em srv1 (62.72.63.18)
- **Alertas:** Zapi (WhatsApp) + Infobip (SMS) → `556598466555`

---

## Estrutura de arquivos

```
controler/
├── controler.py          — FastAPI app (entry point, todos os endpoints)
├── requirements.txt      — fastapi, uvicorn, apscheduler, httpx, boto3, psutil...
├── core/
│   ├── alerts.py         — AlertManager (Zapi + SMS, cooldown, janela silêncio)
│   ├── database.py       — SQLite schema + helpers (get_db_conn)
│   ├── scanner.py        — Resource Scanner (containers, images, volumes, branches, SSM, crons)
│   ├── ssm.py            — get_ssm_param() com lru_cache
│   ├── agent.py          — Agente Claude (legado)
│   └── tools.py          — Ferramentas do agente (legado)
├── static/
│   └── v3/
│       ├── index.html    — Shell Preact sci-fi (sidebar, router, Cmd+K, mobile)
│       ├── components.js — StatusBadge, ProgressBar, GaugeCircle, SparkLine, TerminalLog, StepTracker, DrillCard
│       └── screens/
│           ├── mission-control.js  — Home KPIs + containers + timeline
│           ├── srv1.js             — srv1 Deep Dive com gauges + restart
│           ├── fisiomt.js          — FisioMT VPS + HestiaCP accounts
│           ├── projects.js         — Projetos + deploy history
│           ├── openclaw.js         — APScheduler jobs + agentes OpenClaw
│           ├── scanner.js          — Resource Scanner UI
│           ├── timeline.js         — Feed de eventos com filtros
│           ├── alerts.js           — Alert log + painel de teste
│           └── vault.js            — SSM params agrupados com reveal
├── CHANGELOG.md          — Histórico de versões
├── PLANEJAMENTO.md       — Planejamento original v3 (auditoria)
└── PROMPTS_FASES.md      — Prompts das fases de execução
```

---

## Tabelas SQLite

| Tabela | Propósito |
|--------|-----------|
| `timeline_events` | Feed cronológico de eventos (deploys, alertas, crons) |
| `metrics_snapshots` | Snapshots CPU/RAM por container a cada 2min |
| `alert_log` | Log de alertas enviados (WhatsApp/SMS) |
| `alert_config` | Configuração de regras de alerta |
| `deploy_history` | Histórico completo de deploys |
| `projects` | Projetos monitorados |
| `agent_findings` | Reports dos agentes OpenClaw |
| `memories` | Memórias do agente |
| `rules_text` | Regras em texto |

---

## Endpoints principais

| Endpoint | Descrição |
|----------|-----------|
| `GET /api/health` | Health check (version: 3.0.0) |
| `GET /api/kpis` | KPIs globais do sistema |
| `GET /api/timeline` | Feed de eventos paginado |
| `GET /api/metrics/history` | Histórico CPU/RAM |
| `GET /api/alerts` | Log de alertas |
| `POST /api/alerts/test` | Disparo manual de alerta |
| `GET /api/deploy/history` | Histórico de deploys |
| `GET /api/scheduler/jobs` | Status APScheduler jobs |
| `GET /api/scanner/run` | Executar Resource Scanner |
| `GET /api/scanner/last` | Último resultado do scanner |
| `POST /api/scanner/fix` | Executar ação segura |
| `GET /api/vault/params` | SSM params agrupados |
| `GET /api/openclaw/agents` | Status agentes OpenClaw |
| `GET /api/server/docker/stats` | Stats Docker via socket |
| `GET /api/vps-fisiomt/stats` | Métricas VPS FisioMT |
| `GET /api/vps-fisiomt/hestia/accounts` | Contas HestiaCP |

---

## APScheduler — Cron jobs nativos

| Job | Intervalo | Função |
|-----|-----------|--------|
| `metrics_snapshot` | 2 minutos | Snapshot CPU/RAM de todos containers |
| `health_check` | 5 minutos | Verifica saúde de containers + alertas |
| `deploy_sync` | 10 minutos | Sincroniza estado DEV/GIT/PROD |
| `daily_digest` | 8h BRT | Digest WhatsApp com status do sistema |

---

## Parâmetros SSM (`/controler/*`)

| Parâmetro SSM | Uso |
|---------------|-----|
| `/controler/agent_api_token` | Auth para agentes OpenClaw |
| `/controler/coolify_token` | API do Coolify |
| `/controler/auth_user` | Basic Auth usuário |
| `/controler/auth_pass` | Basic Auth senha |
| `/controler/zapi_token` | API Zapi (WhatsApp) |
| `/controler/zapi_instance_id` | Instância Zapi |
| `/controler/srv1_ssh_password` | SSH srv1 (substituir por chave) |

---

## Regra de Deploy — Triangulação Obrigatória

**NUNCA editar diretamente no servidor (srv1/Coolify/prod).**

```
Mac (dev local) → GitHub (main) → Coolify (prod)
```

```bash
# 1. Validar sintaxe
cd ~/Documents/DEV/controler
python3 -m py_compile controler.py

# 2. Commit e push
git add -A
git commit -m "tipo(escopo): descrição"
git push origin main

# 3. Deploy via Coolify MCP ou API
# coolify_deploy uuid=hksw4kg8owgs0wwg0o8k4kk0 force=true

# 4. Verificar
curl -s https://controler.net.br/api/health
```

**Coolify UUID:** `hksw4kg8owgs0wwg0o8k4kk0`  
**Env vars obrigatórias no Coolify:**
- `PROJECTS_PATH=/projects`
- `AGENT_API_TOKEN` (ou SSM)

---

## Variáveis de ambiente (dev local)

```bash
export PROJECTS_PATH=~/Documents/DEV
export AGENT_API_TOKEN=<valor do SSM>
```

Credenciais SSM em dev: `aws ssm get-parameter --profile cowork-admin --name /controler/xxx`

---

## Pendências conhecidas (v3.1)

- SEC-06: Rate limiting Basic Auth (brute force protection)
- SEC-07: `/api/credentials/{id}/reveal` separado
- Remover sshpass → chave SSH pura
- PWA manifest para instalação mobile
