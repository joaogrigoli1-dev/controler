# Controler — Command Center v3
## Planejamento de Auditoria, Modernização e Transformação

> **Dashboard Operacional Futurista — Interface Sci-Fi em Tempo Real**
>
> | Campo | Valor |
> |---|---|
> | Projeto | Controler — Mesa de Controle Operacional |
> | Versão | v3.0 — Refatoração Completa |
> | Data | 30 de Abril de 2026 |
> | Autor | João Henrique Grigoli — joaogrigoli1@gmail.com |
> | Stack | Python 3.12 · FastAPI · SQLite · React · Docker · Coolify · AWS SSM |
> | Alertas | Zapi (WhatsApp) + SMS API → 65-98466-5555 |

**Estatísticas do plano:** 8 Fases · ~16 dias estimados · 10+ novas features · 8 fixes de segurança

---

## Índice

1. [Auditoria e Estado Atual](#01--auditoria-e-estado-atual)
2. [Análise OpenClaw vs Claude Nativo](#02--análise-openclaw-vs-claude-nativo)
3. [Roadmap de Implementação](#03--roadmap-de-implementação)
4. [Segurança — Correções Obrigatórias](#04--segurança--correções-obrigatórias)
5. [Novas Features Propostas](#05--novas-features-propostas)
6. [Nova Arquitetura e Redesign](#06--nova-arquitetura-e-redesign)
7. [Refatoração UI/UX Futurista](#07--refatoração-uiux-futurista)
8. [Limpeza de Código e Banco de Dados](#08--limpeza-de-código-e-banco-de-dados)
9. [Pesquisa GitHub — Inspirações OSS](#09--pesquisa-github--inspirações-oss)
10. [Estratégia de Deploy e Acesso](#10--estratégia-de-deploy-e-acesso)
11. [Plano de Execução Paralela](#11--plano-de-execução-paralela)

---

## 01 — Auditoria e Estado Atual

O Controler é um dashboard operacional Python/FastAPI com frontend React, rodando localmente na porta 3001 e em produção via Coolify (controler.net.br). É a mesa de controle centralizada de toda a infraestrutura de desenvolvimento.

### O que já funciona ✓

| # | Funcionalidade | Detalhe |
|---|---|---|
| ✓ | Hardware KPIs | CPU, RAM, disco e rede via psutil e Docker socket |
| ✓ | Deploy Pipeline | TypeScript → Build → Git push → Coolify restart → health check |
| ✓ | Sync Triangulação | Compara hash DEV vs GIT vs PROD em tempo real |
| ✓ | OpenClaw Integration | Lê status dos 4 agentes via volume montado |
| ✓ | SSM Credentials Viewer | Lista e visualiza todos os parâmetros recursivamente |
| ✓ | Agent Findings | Endpoint POST que recebe reports dos agentes OpenClaw |
| ✓ | FisioMT Integration | API HestiaCP para servidor secundário 187.77.246.214 |
| ✓ | Basic Auth + Security Headers | Middleware com comparação de tempo constante (hmac) |

### Problemas Críticos Identificados

| ID | Severidade | Problema | Descrição | Arquivo |
|---|---|---|---|---|
| S1 | 🔴 CRÍTICO | AGENT_API_TOKEN hardcoded no código | Token `'openclaw_controler_2026'` literal na linha 56. Expõe acesso ao endpoint de findings. | `controler.py:56` |
| S2 | 🔴 CRÍTICO | Dashboard zerado em produção | `~/Documents/DEV` não existe no container Docker — todos os KPIs ficam zerados. | `controler.py:229` |
| S3 | 🟡 ALTO | Coolify token no path errado do SSM | Lendo de `/myclinicsoft/coolify_token` em vez de `/controler/coolify_token`. | `controler.py:682` |
| S4 | 🟡 ALTO | SSH via sshpass — senha no process list | `sshpass -p {password}` expõe senha em `ps aux`, visível a qualquer processo do sistema. | `controler.py:699` |
| S5 | 🟡 ALTO | Senhas SSH em variáveis globais no startup | `_SRV1_PASS` e `_FISIOMT_PASS` carregadas no boot e ficam em memória global Python. | `controler.py:689` |
| F1 | 🔵 MÉDIO | Dois endpoints de containers duplicados | `/api/containers` (SSH legado) e `/api/server/docker/stats` (socket). Comportamento inconsistente. | `controler.py:254,810` |
| F2 | 🔵 MÉDIO | PROJECTS_PATH hardcoded para Mac | Usado em 4+ endpoints — falha silenciosa em Docker sem variável `PROJECTS_PATH`. | `controler.py:559+` |
| U1 | ⚪ BAIXO | Seed popula projeto 'xospam' | Projeto pode não existir mais. Dados zerados poluem o dashboard. | `controler.py:1572` |

---

## 02 — Análise OpenClaw vs Claude Nativo

OpenClaw é um AI gateway self-hosted com 4 instâncias no srv1 (myclinicsoft, xospam, libertakidz, controler). A análise abaixo determina o que manter e o que substituir por código nativo, eliminando custo desperdiçado.

> ⚠️ **Custo desperdiçado: ~408.000 tokens/dia**
> Container Resources Monitor executa ~17.000 tokens × 24 runs/dia sem nunca coletar dados (SSH bloqueado). Eliminável em < 1 hora.

### Comparativo de Capacidades

| Capacidade | OpenClaw | Claude Nativo (Controler) |
|---|---|---|
| Cron jobs agendados | ✓ Nativo | ✓ Via APScheduler |
| Execução de cmds no servidor | ✗ BLOQUEADO — sem SSH/node | ✓ Via Docker socket |
| Canais de mensagem | ✗ TODOS QUEBRADOS | ✓ Zapi + SMS API |
| Monitoramento de containers | ✗ Falha por SSH bloqueado | ✓ Docker socket montado |
| Custo por health check | ~17.000 tokens/run | ~$0,001 (Haiku 3.5) |
| Configuração via UI | ✗ Formulários quebrados | ✓ Programática / API |
| Deploy automático | ✗ Requer node pareado | ✓ Coolify API já integrada |
| Gateway de chat multicanal | **MANTER** — quando corrigido | Não aplicável |

### Recomendação Estratégica

**MANTER OpenClaw para:**
- Gateway de chat multicanal (WhatsApp, Telegram)
- Routing de mensagens com contexto persistente
- Casos de uso conversacional multi-sessão

**SUBSTITUIR por código nativo:**
- Cron monitoring → APScheduler nativo
- Container health → Docker socket (já funciona)
- Alertas → Zapi + SMS API direto do Controler
- Deploy monitoring → já nativo

---

## 03 — Roadmap de Implementação

Plano de 8 fases sequenciais com paralelismo interno. Duração total estimada: **~16 dias úteis** sequencial ou **~8 dias** com 3 agentes em paralelo.

### FASE 0 — Hotfixes de Segurança
> **Dias: 1 · Esforço: 2h · STATUS: 🔴 BLOQUEANTE — executar antes de tudo**

Mover `AGENT_API_TOKEN` para SSM. Corrigir path do Coolify token. Lazy loading de senhas SSH. Adicionar `PROJECTS_PATH` env var.

### FASE 1 — Backend Modernization
> **Dias: 2–4 · Esforço: 16h**

APScheduler para crons nativos. Endpoints `/api/alerts`, `/api/timeline`, `/api/metrics/history`. Remover endpoint duplicado `/api/containers`. Expandir SQLite com 5 novas tabelas.

### FASE 2 — Alert System
> **Dias: 3–5 · Esforço: 8h · Paralelo com F1**

Integrar Zapi API (WhatsApp) e SMS API. `AlertManager` Python com threshold, cooldown 30min, janela de silêncio 22h–7h BRT. Alertas automáticos para `65-98466-5555`.

### FASE 3 — Frontend Architecture
> **Dias: 5–7 · Esforço: 16h · Paralelo com F2**

Substituir Babel transpilation por Preact+HTM ou Vite. Novo design system sci-fi. Hash-based routing. Componentes base: `GaugeCircle`, `SparkLine`, `StatusBadge`, `TerminalLog`.

### FASE 4 — Futuristic UI
> **Dias: 8–14 · Esforço: 60h · Paralelo com F5**

10 telas completas: Mission Control, srv1 Deep Dive, Container Grid, FisioMT Panel, Deploy Pipeline, OpenClaw Console, Timeline, Alert Center, Vault, Scanner.

### FASE 5 — Resource Scanner
> **Dias: 12–15 · Esforço: 16h · Paralelo com F4**

Interface clicável que detecta containers parados, images dangling, SSM params sem uso, branches antigas, crons com 100% erro rate. Sugestões + botão Corrigir.

### FASE 6 — Polish e Mobile
> **Dias: 14–16 · Esforço: 12h · Após F4**

Layout responsivo com sidebar colapsável. Touch-friendly (48px min). Keyboard shortcuts `Cmd+K`. PWA manifest. Loading skeletons.

### FASE 7 — Deploy e Documentação
> **Dias: 16 · Esforço: 4h · Último**

Dockerfile com `PROJECTS_PATH`. Coolify env vars via API. `CHANGELOG.md`. Atualização do `CLAUDE.md`. Verificação final de segurança.

### Cronograma Resumido

| Fase | Descrição | Duração | Paralelo? |
|---|---|---|---|
| Fase 0 | Hotfixes de Segurança — BLOQUEANTE | 2h | ❌ NÃO |
| Fase 1 | Backend Modernization | 3 dias | Parcial |
| Fase 2 | Alert System | 2 dias | ✅ SIM |
| Fase 3 | Frontend Architecture | 2 dias | ✅ SIM |
| Fase 4 | Futuristic UI Implementation | 7 dias | ✅ SIM |
| Fase 5 | Resource Scanner | 3 dias | ✅ SIM |
| Fase 6 | Polish e Mobile | 2 dias | Após F4 |
| Fase 7 | Deploy e Documentação | 1 dia | Último |
| **TOTAL** | **Sequencial: ~16 dias · Com 3 agentes: ~8 dias** | **~16 dias** | **50% ganho** |

---

## 04 — Segurança — Correções Obrigatórias

> 🔴 **Implementar imediatamente — antes de qualquer commit.**
> Nenhum código deve ser feito enquanto SEC-01 e SEC-02 estiverem abertos.

| ID | Severidade | Problema | Correção |
|---|---|---|---|
| SEC-01 | 🔴 CRÍTICO | AGENT_API_TOKEN hardcoded | Token literal `'openclaw_controler_2026'` na linha 56. Mover para `/controler/agent_api_token` no SSM com valor gerado por `openssl rand -hex 32`. Remover fallback — se não existir no SSM, lançar `RuntimeError`. |
| SEC-02 | 🔴 CRÍTICO | Dashboard zerado em produção | `~/Documents/DEV` não existe no container. Adicionar variável `PROJECTS_PATH`. Configurar volume Docker `/projects` no Coolify apontando para a pasta local. |
| SEC-03 | 🟡 ALTO | Coolify token no path errado | Lendo de `/myclinicsoft/coolify_token`. Corrigir para `/controler/coolify_token` e criar o parâmetro SSM correto para evitar cruzamento de credenciais entre projetos. |
| SEC-04 | 🟡 ALTO | SSH via sshpass — senha no process list | `sshpass -p {password}` expõe a senha no output de `ps aux`, visível a qualquer processo. Substituir por chave SSH (`~/.ssh/coolify_server` já existe). Remover sshpass. |
| SEC-05 | 🟡 ALTO | Senhas SSH em variáveis globais | `_SRV1_PASS` e `_FISIOMT_PASS` carregadas no startup e ficam na memória global. Substituir por `@functools.lru_cache` com TTL de 5 minutos. |
| SEC-06 | 🔵 MÉDIO | Basic Auth sem rate limiting | Sem proteção contra brute force. Adicionar rate limiter: máx 5 tentativas/IP em 5 min. Bloquear por 15 minutos após exceder. Logar todas as tentativas falhas. |
| SEC-07 | 🔵 MÉDIO | `/api/credentials` expõe valores SSM descriptografados | Retorna valores reais de todos os parâmetros. Mascarar no frontend (mostrar tipo e data). Criar endpoint separado `/api/credentials/{id}/reveal` com autenticação adicional. |
| SEC-08 | 🔵 MÉDIO | Content Security Policy ausente | Nenhum header CSP. Adicionar ao middleware: `default-src 'self'`, `script-src 'self' fonts.googleapis.com`, `connect-src 'self'`, `frame-ancestors 'none'`. |

### Parâmetros SSM a Criar / Verificar

| Parâmetro SSM | Tipo | Descrição |
|---|---|---|
| `/controler/agent_api_token` | SecureString | Token de autenticação para agentes OpenClaw — gerar com `openssl rand -hex 32` |
| `/controler/coolify_token` | SecureString | Token da API do Coolify (não usar `/myclinicsoft/`) |
| `/controler/auth_user` | String | Usuário do Basic Auth |
| `/controler/auth_pass` | SecureString | Senha do Basic Auth |
| `/controler/zapi_token` | SecureString | Token da API Zapi para WhatsApp |
| `/controler/zapi_instance_id` | String | ID da instância Zapi |
| `/controler/alert_phone` | String | Número alvo de alertas: `556598466555` |
| `/controler/sms_api_key` | SecureString | Chave API para SMS — Infobip ou Twilio |
| `/controler/srv1_ssh_password` | SecureString | Senha SSH srv1 — SUBSTITUIR por chave SSH a curto prazo |

---

## 05 — Novas Features Propostas

| ID | Prioridade | Feature | Descrição |
|---|---|---|---|
| FEAT-01 | 🔴 ALTA | Alert System Ativo | Zapi (WhatsApp) + SMS API. Target: `65-98466-5555`. AlertManager com threshold, cooldown 30min, janela silêncio 22h–7h. `CRITICAL`=WhatsApp+SMS, `WARNING`=WhatsApp, `INFO`=log. |
| FEAT-02 | 🔴 ALTA | Timeline de Eventos | Feed cronológico unificado: deploys, commits, alertas, restarts. Estilo GitHub Activity. Nova tabela `timeline_events` no SQLite. |
| FEAT-03 | 🔴 ALTA | Métricas Históricas com Gráficos | Snapshots de CPU/RAM por container a cada 5 min via APScheduler. Sparklines 24h por container. Tabela `metrics_snapshots`. |
| FEAT-04 | 🔴 ALTA | Container Log Viewer | Tail de logs Docker via socket. Streaming por SSE. Modal com scroll automático, filtro por nível. `GET /api/server/containers/{id}/logs`. |
| FEAT-05 | 🔴 ALTA | APScheduler Native Crons | Substituir OpenClaw monitoring (408k tokens/dia desperdiçados) por jobs Python: health check 5min, container metrics 2min, deploy sync 10min, digest 8h BRT. |
| FEAT-06 | 🟡 MÉDIA | Resource Scanner | Escaneia containers parados, images dangling, SSM params sem ref, branches antigas, crons com 100% erro. Sugestões com botão 'Corrigir'. |
| FEAT-07 | 🟡 MÉDIA | Global Search — Cmd+K | Busca unificada por containers, SSM parameters, timeline events, memories e regras. Resultado instantâneo com fuzzy matching. |
| FEAT-08 | 🟡 MÉDIA | Digest Diário Automatizado | Cron 8h BRT → WhatsApp `65-98466-5555` com: status containers, custo IA ontem, deploys, alertas pendentes. Formato compacto e legível no celular. |
| FEAT-09 | 🟡 MÉDIA | Deploy Multi-Projeto | Expandir deploy automatizado para LibertaKidz e Controler (self-deploy). Pipeline genérico reutilizável via dicionário `DEPLOY_CONFIGS`. |
| FEAT-10 | 🔵 BAIXA | FisioMT Full Integration | Completar HestiaCP: restart/stop de serviços (nginx, mysql), logs de domínio, criação de contas, monitor de uptime dos domínios hospedados. |

---

## 06 — Nova Arquitetura e Redesign

### Hierarquia de Navegação — Information Architecture

```
MISSION CONTROL (Home)
  └─ Mapa visual de todos os servidores, status em tempo real, alert feed, KPIs globais

INFRAESTRUTURA
  ├─ srv1 (62.72.63.18)
  │    ├─ Hardware, Containers, Apps Coolify, OpenClaw Agents
  │    └─ [Container] → drill-down
  │         └─ Logs ao vivo, restart, stats, portas, env vars (mascaradas)
  └─ FisioMT (187.77.246.214)
       └─ Serviços HestiaCP, contas, domínios, recursos

PROJETOS
  ├─ MyClinicSoft 🏥  — Deploy pipeline, sync DEV/GIT/PROD, container health, memories, regras
  ├─ LibertaKidz 👧  — Deploy, container, memories
  └─ Controler 🎛️   — Self-deploy, container, memories

AGENTES (OpenClaw)
  └─ Status + Cron Jobs
       └─ Status de cada agente, cron jobs com histórico, run manual, configuração

TIMELINE   — Feed cronológico de todos os eventos do sistema
ALERTAS    — Feed de alertas ativos, configuração de thresholds, histórico de envios
VAULT      — SSM Parameters agrupados por serviço — valores mascarados
SCANNER    — Recursos não utilizados, erros detectados, sugestões de correção
```

### Novas Tabelas SQLite

| Tabela | Colunas Principais | Propósito |
|---|---|---|
| `timeline_events` | `ts, event_type, severity, project, title, detail, actor, metadata` | Feed cronológico de eventos do sistema |
| `metrics_snapshots` | `ts, server, container_name, cpu_percent, mem_mb, mem_percent` | Histórico de métricas para sparklines e gráficos |
| `alert_log` | `ts, severity, title, body, channel, sent, error` | Log de alertas enviados e falhas de entrega |
| `alert_config` | `rule_name, enabled, threshold, cooldown_min, min_severity` | Configuração das regras de alerta por tipo |
| `deploy_history` | `ts, project, status, triggered_by, commit_hash, duration_sec, log_summary` | Histórico completo de todos os deploys |

---

## 07 — Refatoração UI/UX Futurista

> **Filosofia:** Minority Report operations center + Grafana dark theme + Coolify UI.
> Dark by default com dados em tempo real, alta densidade com hierarquia clara, tudo clicável com drill-down, cores semânticas e glassmorphism sutil.

### Design Tokens — Paleta Sci-Fi

| Token CSS | Hex | Uso Principal |
|---|---|---|
| `--cyan` | `#00d4ff` | Cor primária HUD — títulos, bordas ativas, glow |
| `--green` | `#00e87a` | Status saudável — running, synced, ok, healthy |
| `--red` | `#ff3366` | Crítico — errors, stopped, security issues |
| `--yellow` | `#ffcc00` | Aviso — warnings, thresholds, review needed |
| `--purple` | `#9945ff` | IA / OpenClaw — agentes, ML, processamento |
| `--bg` | `#020308` | Background principal — quase preto com matiz azul |
| `--surface` | `#080c18` | Cards e panels — um passo acima do bg |
| `--border` | `#0d1f3c` | Bordas sutis |
| `--text` | `#e2e8f0` | Texto principal |
| `--muted` | `#64748b` | Texto secundário |

### Componentes a Criar

| Componente | Descrição | Usado em |
|---|---|---|
| `GaugeCircle` | Medidor circular estilo HUD para CPU/RAM — velocímetro animado | srv1, FisioMT |
| `SparkLine` | Gráfico de linha minimal inline sem lib externa — histórico 24h | containers, overview |
| `StatusBadge` | Badge semântico com pulse animation para healthy/error/warning | todos os cards |
| `ProgressBar` | Barra com threshold colors automáticos — verde/amarelo/vermelho | CPU, RAM, disco |
| `TerminalLog` | Visor de logs monospace com scroll automático e filtro por nível | container logs, deploy |
| `StepTracker` | Rastreador de passos animado para pipelines de deploy — 9 steps | Deploy screen |
| `AlertBanner` | Banner contextual com severidade — persistente ou dismissível | alert center |
| `DrillCard` | Card clicável com hover state, chevron e animação de entrada | Mission Control |
| `ScannerResult` | Card de resultado do scanner com severidade, descrição e botão de ação | Scanner screen |

### O que Remover

| Arquivo / Elemento | Motivo |
|---|---|
| `controler.py:254` — `/api/containers` (SSH) | Duplicado de `/api/server/docker/stats` — manter apenas via socket |
| `controler.py:1572` — seed xospam | Projeto pode não existir — verificar e remover do seed |
| `core/tools.py` — refs a `187.77.40.102` | Servidor antigo srv2 completamente desativado |
| `static/vendor/babel.min.js` | Transpilation in-browser lento — substituir por build moderno |
| `documentacao/FASE7_CONTROLER_ANALYSIS.md` | Análise da migração srv2→srv1 já concluída — obsoleta |
| `prompts/PROMPT_MIGRAR_SSM*.md` | Prompts de migração para SSM — migração já concluída |

---

## 08 — Limpeza de Código e Banco de Dados

Remoção de código obsoleto, otimização do SQLite e implementação do Resource Scanner interativo que detecta e sugere correções automaticamente.

### Operações SQLite

```sql
-- Remover projeto obsoleto
DELETE FROM projects WHERE id = 'xospam';

-- Limpar findings resolvidos antigos
DELETE FROM agent_findings WHERE status='resolved' AND created_at < datetime('now', '-90 days');

-- Manter janela deslizante de métricas (7 dias)
DELETE FROM metrics_snapshots WHERE ts < datetime('now', '-7 days');

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_timeline_events_ts_project ON timeline_events(ts, project);
CREATE INDEX IF NOT EXISTS idx_metrics_snapshots_ts ON metrics_snapshots(ts);

-- Manutenção
VACUUM;
ANALYZE;
```

### Resource Scanner — Categorias Detectadas

| Categoria | O que detecta | Ação sugerida | Impacto |
|---|---|---|---|
| Containers | Parados há > 7 dias | `docker rm {id}` | Libera recursos |
| Storage | Docker images dangling sem container | `docker image prune` | Recupera GB de disco |
| Git | Branches sem commit há > 30 dias | `git branch -d {branch}` | Limpa repo |
| SSM | Parâmetros sem referência em projetos | Revisar manualmente | Reduz custo SSM |
| Crons | Jobs com 100% erro rate no último mês | Desativar ou corrigir | Elimina custo de tokens |
| Volumes | Docker volumes sem container montado | `docker volume prune` | Libera disco |

---

## 09 — Pesquisa GitHub — Inspirações OSS

| Projeto | Stars | Principal Feature a Adotar |
|---|---|---|
| Uptime Kuma | 60k+ | Status page, alertas multi-canal, heartbeat por URL, círculos 30-day uptime |
| Portainer CE | 30k+ | Container log viewer com stream ao vivo, shell exec, volume browser, stats com gráficos |
| Grafana | 65k+ | Time-range selector, threshold lines nos gráficos, alerting com routing rules |
| Netdata | 71k+ | Métricas a cada 1 segundo, anomaly detection automático, charts interativos com zoom |
| Dashdot | 3k+ | Glassmorphism cards, CPU/RAM gauges animados — exatamente o estilo visual desejado |
| Coolify | 35k+ | Design dos deploy logs terminal-style, activity feed, environment variables UI mascaradas |
| Cronitor | SaaS | Alertas de 'missed run', heartbeat por URL, agrupamento de erros consecutivos em um card |
| Linear | SaaS | Notificações inteligentes, busca global Cmd+K, timeline de atividades unificada |

---

## 10 — Estratégia de Deploy e Acesso

> 🔴 **Regra absoluta imutável:**
> `Mac Local (dev)` → `GitHub (main)` → `Coolify (prod)`
>
> NUNCA editar diretamente no srv1. NUNCA git push apenas para testar. SEMPRE validar localmente primeiro.

### Matriz DEV vs PROD

| Aspecto | DEV — Mac local | PROD — Coolify/Docker |
|---|---|---|
| URL | `http://localhost:3001` | `https://controler.net.br` |
| `PROJECTS_PATH` | `~/Documents/DEV` | `/projects` (volume montado) |
| SSM Auth | profile `cowork-admin` | IAM Role do container |
| Docker socket | Não disponível (local) | ✓ `/var/run/docker.sock` |
| OpenClaw volumes | Não disponível | ✓ `/opt/openclaw-*` (montados) |
| Reload | `uvicorn reload=True` | `reload=False` |

### UUIDs Coolify — Referência

| Serviço | UUID Coolify | Porta | URL Produção |
|---|---|---|---|
| MyClinicSoft | `jckc0ccwssowwc0oocw80ogs` | 5000 | myclinicsoft.com.br |
| LibertaKidz | `yow040wosgowks8o80gk88g4` | 3000 | `*.sslip.io` |
| Controler | `hksw4kg8owgs0wwg0o8k4kk0` | 3001 | controler.net.br |
| WA Buffer | `nw48cggkk4ss4g00s08s8wkw` | 3001 | dev.myclinicsoft.com.br |

### Sequência de Deploy Controler

```bash
# 1. Validar localmente
cd ~/Documents/DEV/controler
python3 -m py_compile controler.py  # sem erros de sintaxe

# 2. Commit e push
git add -A
git commit -m "feat(v3): descrição da mudança"
git push origin main

# 3. Acionar Coolify via API
curl -X POST "http://62.72.63.18:8000/api/v1/applications/hksw4kg8owgs0wwg0o8k4kk0/restart" \
  -H "Authorization: Bearer $COOLIFY_TOKEN" \
  -H "Accept: application/json"

# 4. Verificar saúde
curl -s "https://controler.net.br/api/health"
```

---

## 11 — Plano de Execução Paralela

Com 3 agentes em paralelo por sprint, redução de ~16 para ~8 dias úteis.

### Sprint 1 — Dias 1–2 (Segurança + Base)

| Agente A — Security | Agente B — Backend Base |
|---|---|
| SEC-01: `AGENT_API_TOKEN` → SSM | `PROJECTS_PATH` env var |
| SEC-02: Fix Coolify token path | Remover `/api/containers` duplicado |
| SEC-03: Lazy loading senhas SSH | Expandir SQLite schema |
| SEC-08: CSP header | APScheduler no lifespan |

### Sprint 2 — Dias 3–5 (Features Backend)

| Agente A — Alerts | Agente B — Metrics | Agente C — Container Logs |
|---|---|---|
| Integrar Zapi API (WhatsApp) | Endpoint `/api/metrics/history` | `GET /api/server/containers/{id}/logs` |
| Integrar SMS API | Snapshot job 5min | Docker socket streaming |
| AlertManager Python class | Timeline logger | Deploy history table |
| Endpoint `/api/alerts/test` | Endpoint `/api/timeline` | — |

### Sprint 3 — Dias 5–10 (Frontend Architecture)

| Agente A — Design System | Agente B — Componentes | Agente C — Routing |
|---|---|---|
| CSS variables sci-fi | `GaugeCircle` + `SparkLine` | Hash-based router |
| Animation keyframes | `StatusBadge` + `ProgressBar` | Navigation state |
| Layout shell sidebar+main | `TerminalLog` + `StepTracker` | Deep-link support |

### Sprint 4 — Dias 8–14 (UI Screens)

| Agente A — Server Screens | Agente B — Project Screens | Agente C — Support Screens |
|---|---|---|
| Mission Control (home) | Project Overview + Deploy Pipeline | Timeline + Alert Center |
| srv1 Deep Dive + Container Grid | Sync Status + Memories | Vault (SSM) + Scanner |
| FisioMT Panel | — | — |

### Ganho com Paralelismo

| Modo | Tempo Estimado | Ganho |
|---|---|---|
| Sequencial — 1 agente | ~16 dias úteis | Baseline |
| Paralelo — 3 agentes/sprint | **~8 dias úteis** | **50% redução** |
| Paralelo — 5 agentes/sprint | **~5 dias úteis** | **69% redução** |

---

## Resumo Executivo

🔴 **SEGURANÇA (urgente)** — 1 token hardcoded + senhas em variáveis globais → mover para SSM lazy loading. Implementar ANTES de qualquer outro trabalho.

⚠️ **ALERTAS (urgente)** — Não existe nenhum alerta ativo. Implementar Zapi + SMS para `65-98466-5555` em ~1 dia. Eliminar 408k tokens/dia desperdiçados no OpenClaw.

🖥️ **UI (principal transformação)** — Migrar do React inline com Babel para componentes modernos com estética sci-fi, drill-down por clique e dados em tempo real.

⚙️ **CRONS NATIVOS** — Substituir OpenClaw monitoring (quebrado + caro) por APScheduler nativo com Docker socket.

📊 **HISTÓRICO DE MÉTRICAS** — Snapshots a cada 5 min para sparklines e visualização de trends por container.

🔍 **RESOURCE SCANNER** — Feature nova: interface clicável que detecta e corrige recursos não utilizados em todos os sistemas.

---

*Gerado em 30/04/2026 · Controler Command Center v3 · joaogrigoli1@gmail.com*
