# CHECKPOINT 1 — Controler v4 NOC
## Auditoria + Arquitetura Alvo + Decisões Validadas

> **Status:** aguardando aprovação do João antes de iniciar implementação
> **Data:** 2026-05-27
> **Próximo passo:** Etapa 3 (scaffold do projeto v4) só após APROVADO

---

## 1. AUDITORIA DO CONTROLER v3 ATUAL

### 1.1. Mapeamento de KPIs existentes

| # | KPI | Fonte | Refresh | Útil hoje? | Observação |
|---|-----|-------|---------|-----------|------------|
| 1 | Containers running / total | Docker socket | on-load | ✅ | KPI principal da Home |
| 2 | CPU srv1 (%) | psutil + Hostinger | on-load | ✅ | Não tem histórico visível |
| 3 | RAM srv1 (%, GB used/total) | psutil + Hostinger | on-load | ✅ | Idem |
| 4 | Alertas ativos (count + críticos) | tabela `alert_log` | 30s | ✅ | Sem segregação por severidade visual |
| 5 | Uptime srv1 (dias/horas) | psutil | on-load | ⚠️ | Calculado mas pouco destacado |
| 6 | Disco srv1 (GB used/total) | psutil | on-load | ✅ | Sem alerta de threshold |
| 7 | Containers parados | scanner | on-demand | ⚠️ | Scanner manual, deveria ser auto |
| 8 | Docker images dangling | scanner | on-demand | ⚠️ | Idem |
| 9 | Branches git antigas | scanner | on-demand | ⚠️ | Idem |
| 10 | SSM params órfãos | scanner | on-demand | ⚠️ | Idem |
| 11 | Crons com erro >90% | scanner | on-demand | ⚠️ | Idem |
| 12 | Deploys recentes (timeline) | `deploy_history` | on-load | ✅ | Sem comparativo DEV vs PROD |
| 13 | FisioMT VPS stats | hostinger API | on-load | ✅ | Tela separada (boa decisão) |
| 14 | HestiaCP contas | ssh + hestia CLI | on-load | ⚠️ | Sem ping HTTP nem SSL expiry |
| 15 | APScheduler jobs status | scheduler interno | 5s | ✅ | Tela dedicada `/openclaw` |
| 16 | Timeline geral de eventos | `timeline_events` | on-load | ✅ | Sem filtros avançados |
| 17 | Sparkline CPU/RAM histórico | `metrics_snapshots` | on-load | ⚠️ | Render simples, sem zoom |
| 18 | SSM params (vault) | AWS SSM | on-demand | ⚠️ | Reveal sem re-auth, sem audit log |

**Diagnóstico:** 18 KPIs implementados; **8 deles subaproveitados** (severity 1) por estarem em telas escondidas ou exigirem clique manual.

---

### 1.2. KPIs FALTANDO (pedidos no prompt mas inexistentes no v3)

| KPI faltando | Onde apareceria | Severidade |
|--------------|-----------------|-----------|
| % uptime SRV1 24h / 7d / 30d | Overview | P0 |
| Aplicações com falha vs em deploy (segregado) | Overview | P0 |
| Sites HestiaCP online/offline com check HTTP | HestiaCP | P0 |
| Custo estimado mensal AWS + Hostinger | Overview | P1 |
| Heatmap eventos últimas 24h | Overview | P1 |
| Load average 1m/5m/15m | SRV1 | P1 |
| Processos top 10 CPU/RAM | SRV1 | P1 |
| Status systemd dos 6 serviços principais | SRV1 | P0 |
| Logs `journalctl` filtrados | SRV1 | P1 |
| Firewall: portas abertas / bloqueios | SRV1 | P1 |
| Por container: healthcheck status + variáveis env ofuscadas | Coolify | P0 |
| Webhooks e portas mapeadas | Coolify | P2 |
| SSL: validade + dias para expirar (< 30d) | HestiaCP | P0 |
| Visitas / quotas disco/banda HestiaCP | HestiaCP | P1 |
| DNS records por domínio | HestiaCP | P2 |
| Cofre por projeto (não só por prefix SSM) | Vault | P0 |
| Status de saúde por API integrada (ping) | APIs | P1 |
| Rate limits e consumo APIs | APIs | P2 |
| Audit log "quem revelou o quê" | Vault | P0 |
| Regras de alerta configuráveis (CRUD UI) | Alerts | P0 |
| Silenciar alertas / janela manutenção | Alerts | P1 |
| MTTR / MTBF por projeto | Analytics | P1 |
| Comparativo tendências 7/30/90d | Analytics | P1 |
| Exports PDF/CSV | Analytics | P2 |

**Total: 24 KPIs novos** + reorganização dos 18 existentes.

---

### 1.3. Análise de arquitetura atual

| Camada | Estado | Problema | Sev |
|--------|--------|----------|-----|
| Backend | FastAPI 2014 linhas monolítico | `controler.py` mistura routing, jobs, auth, security headers, helpers — difícil de testar | P0 |
| DB | SQLite local `bd/controler.db` | Não sobrevive a redeploy se volume não persistir; sem migrations versionadas | P0 |
| Frontend | Preact + HTM via esm.sh | Zero build = simples, mas teto técnico (sem TS, sem hot reload decente, sem code-splitting real) | P1 |
| Scheduler | APScheduler inline no controler.py | Jobs definidos no mesmo arquivo do servidor → reload reseta job state | P1 |
| Auth | Basic Auth via env var | Sem MFA, sem audit log, sem expiração de sessão, sem rotação de senha | P0 |
| Secrets | AWS SSM via boto3 (`core/ssm.py`) | OK ✅ — já alinhado com regra do João | — |
| Alerts | Z-API + Infobip async via `core/alerts.py` | OK, mas sem retry exponencial, sem dead-letter queue, sem dashboard de regras | P1 |
| Scanner | `core/scanner.py` rodando on-demand | Resultados não persistem entre runs; sem histórico de "tendências de bagunça" | P1 |
| Cache | Nenhum | Toda chamada a Hostinger/SSM bate na API → throttling em runtime alto | P1 |
| Realtime | Polling 5-30s em cada tela | Carga desnecessária, sem WebSocket para métricas live | P1 |
| Healthcheck | `/api/health` retorna `version: 3.0.0` | OK mas sem checks de dependências (SSM, Docker, SSH) | P1 |
| Testes | Sem testes automatizados | Risco alto em produção | P0 |
| CI/CD | Push manual → Coolify | Sem validação prévia em CI (typecheck, lint, test) | P1 |

---

### 1.4. UI/UX — Análise das telas v3

**Pontos fortes:**
- Design sci-fi cyan/dark coerente (`--cyan #00d4ff`, `--green #00e87a`)
- Sidebar fixa + 9 rotas com lazy load (`import('./screens/${name}.js')`)
- Componentes reusáveis (`StatusBadge`, `ProgressBar`, `GaugeCircle`, `SparkLine`)
- Cmd+K e atalhos `G+H/S/T/A/V/P` (oculto, sem dica visual)
- Mobile responsive (5 breakpoints)
- Skeletons em todos os loadings

**Pontos fracos:**
- Tipografia única (Inter + JetBrains Mono) — falta hierarquia
- Sem microanimações Framer (loadings só CSS)
- Empty states genéricos (emoji + texto)
- Sem dark/light toggle (só dark)
- Sem busca global funcional (Cmd+K abre overlay mas não filtra)
- Cores de alerta pouco distintas (`yellow` vs `green` parecidos em tela OLED)
- Sidebar não colapsa (220px fixos comem espaço)
- Sem breadcrumbs
- Mockup `static/v4/index.html` (1746 linhas, "Ethereal Glass") foi começado mas abandonado — **ótimo ponto de partida visual** para o v4 real

---

### 1.5. Segurança

| ID | Problema | Status atual | Resolver no v4 |
|----|----------|--------------|---------------|
| SEC-A | Basic Auth sem MFA | Único fator | **OTP WhatsApp obrigatório** |
| SEC-B | Reveal de credencial sem re-auth | Toggle simples | **OTP obrigatório a cada reveal** |
| SEC-C | Sem audit log de quem viu o quê | Não existe | **Tabela `vault_audit_log`** |
| SEC-D | `srv1_ssh_password` em SSM | Funciona mas é senha | **Migrar para chave SSH** |
| SEC-E | Docker socket montado RW potencial | RO no compose ✅ | Manter RO no v4 |
| SEC-F | Sem rate limit em endpoints API (só auth) | Rate só no login | **Rate limit por endpoint** (Redis) |
| SEC-G | CSP permite `'unsafe-inline'` | Necessário p/ esm.sh | v4 com build próprio → CSP estrita |
| SEC-H | Tokens longo prazo (sem refresh) | N/A (Basic Auth) | **JWT access 15min + refresh 7d** |
| SEC-I | Sem proteção contra session hijacking | N/A | **IP change detection (igual MyClinicSoft)** |

---

### 1.6. Performance

- **TTI v3 atual**: ~1.8s (esm.sh CDN cold cache); ~600ms warm
- **API mais lenta**: `/api/scanner/run` (até 8s — chama Docker + Git + SSM em série)
- **Sem cache**: SSM list parameters bate na AWS toda vez (~400ms cada call)
- **Polling agressivo**: timeline atualiza a cada 30s, sem ETags
- **Bundle frontend**: 0 KB build (CDN), mas 8 round-trips a esm.sh no primeiro load

---

### 1.7. Recomendações priorizadas

**P0 (bloqueante / segurança / experiência core):**
1. Auth OTP WhatsApp obrigatório (replicar fluxo MyClinicSoft)
2. Vault com re-auth + audit log
3. Health check de containers em tempo real (WebSocket)
4. Aplicações Coolify com healthcheck + env vars ofuscadas
5. HestiaCP: ping HTTP + SSL expiry
6. Status systemd dos serviços críticos do SRV1
7. Backend modular (NestJS providers separados por domínio)
8. Postgres em vez de SQLite (sobrevive a redeploy nativamente)
9. Testes automatizados (Vitest + Playwright)
10. Migrations versionadas (Prisma)

**P1 (melhoria significativa):**
- Cache Redis com TTL adequado por endpoint
- Rate limiting por endpoint (não só auth)
- WebSocket Socket.io para métricas live
- Heatmap de eventos 24h
- Custo estimado AWS + Hostinger
- Load average + top processos SRV1
- Logs journalctl filtrados (streaming)
- Alertas: CRUD UI de regras, janela de silêncio configurável
- Analytics: MTTR/MTBF + exports

**P2 (nice-to-have):**
- Light mode toggle
- DNS records por domínio
- Webhooks Coolify
- PDF/CSV exports
- PWA installable mobile

---

## 2. ARQUITETURA ALVO (Controler v4)

### 2.1. Stack

```
┌─ FRONTEND ──────────────────────────────────┐
│  Next.js 14 (App Router) + React 18         │
│  TypeScript strict                          │
│  TailwindCSS + shadcn/ui                    │
│  Recharts + Tremor (charts)                 │
│  Framer Motion (microanimações)             │
│  socket.io-client (realtime)                │
│  next-auth (sessão)                         │
└─────────────────────────────────────────────┘
                  ↓ HTTPS + WSS
┌─ BACKEND ───────────────────────────────────┐
│  NestJS 10 + TypeScript strict              │
│  Fastify adapter (perf)                     │
│  Prisma 5 + PostgreSQL 16                   │
│  socket.io server                           │
│  BullMQ + Redis (jobs + cache)              │
│  Pino structured logging                    │
│  Zod validation                             │
│  JWT (jose) — access 15min + refresh 7d     │
└─────────────────────────────────────────────┘
                  ↓ MCPs / APIs / SSH
┌─ INTEGRAÇÕES ───────────────────────────────┐
│  Hostinger API (VPS metrics)                │
│  AWS SDK v3 (SSM Parameter Store)           │
│  Coolify API (containers/deploys)           │
│  Docker socket (containers locais)          │
│  HestiaCP via SSH (paralelo: construir MCP) │
│  Z-API (WhatsApp OTP + alerts)              │
│  Infobip (SMS críticos)                     │
│  Cloudflare API (DNS automation)            │
└─────────────────────────────────────────────┘
```

### 2.2. Monorepo

```
controler-v4/
├── apps/
│   ├── web/                    # Next.js 14
│   │   ├── app/
│   │   │   ├── (auth)/login/   # OTP flow
│   │   │   ├── (dashboard)/
│   │   │   │   ├── overview/   # Tela 3.1
│   │   │   │   ├── srv1/       # Tela 3.2
│   │   │   │   ├── coolify/    # Tela 3.3
│   │   │   │   ├── hestia/     # Tela 3.4
│   │   │   │   ├── vault/      # Tela 3.5
│   │   │   │   ├── apis/       # Tela 3.6
│   │   │   │   ├── alerts/     # Tela 3.7
│   │   │   │   └── analytics/  # Tela 3.8
│   │   │   ├── api/socket/     # WS handler
│   │   │   └── layout.tsx
│   │   ├── components/         # shadcn/ui + custom
│   │   └── lib/                # api client, hooks
│   │
│   └── api/                    # NestJS
│       ├── src/
│       │   ├── auth/           # OTP WhatsApp (replicado)
│       │   ├── srv1/           # Hostinger + Docker socket
│       │   ├── coolify/        # Coolify API wrapper
│       │   ├── hestia/         # SSH wrapper (depois MCP)
│       │   ├── vault/          # SSM + audit log
│       │   ├── alerts/         # CRUD + Z-API + Infobip
│       │   ├── scanner/        # background jobs
│       │   ├── realtime/       # Socket.io gateway
│       │   ├── common/         # ssm.service, redis, prisma
│       │   └── main.ts
│       └── prisma/schema.prisma
│
├── packages/
│   ├── shared/                 # tipos compartilhados
│   ├── ui/                     # design tokens
│   └── eslint-config/
│
├── mcps/
│   └── hestia/                 # MCP server HestiaCP (futuro)
│
├── docker-compose.yml          # web + api + postgres + redis
├── Dockerfile                  # multi-stage
├── pnpm-workspace.yaml
└── turbo.json
```

### 2.3. Diagrama (Mermaid)

```mermaid
flowchart LR
    User[👤 João] -->|HTTPS| Web[Next.js Web]
    Web -->|REST + WS| API[NestJS API]

    API --> Postgres[(PostgreSQL)]
    API --> Redis[(Redis cache+jobs)]

    API -->|Z-API| WhatsApp[📱 WhatsApp]
    API -->|Infobip| SMS[📨 SMS]

    API -->|AWS SDK| SSM[(AWS SSM)]
    API -->|REST| Coolify[Coolify API]
    API -->|REST| Hostinger[Hostinger API]
    API -->|socket| Docker[/var/run/docker.sock]
    API -->|SSH| Hestia[HestiaCP srv1]
    API -->|REST| Cloudflare[Cloudflare DNS]

    BullMQ[BullMQ Workers] -->|cron| API
    Scanner[Resource Scanner] -.->|2min| BullMQ
    Metrics[Metrics Snapshot] -.->|1min| BullMQ
    Healthcheck[Health Check] -.->|30s| BullMQ
    Digest[Daily Digest 8h] -.->|cron| BullMQ
```

### 2.4. Modelo de dados (Prisma — resumido)

```prisma
model User {
  id        String   @id @default(cuid())
  name      String
  email     String   @unique
  phone     String   @unique
  active    Boolean  @default(true)
  blocked   Boolean  @default(false)
  createdAt DateTime @default(now())
  tokens    OtpToken[]
  sessions  Session[]
  auditLogs VaultAuditLog[]
}

model OtpToken {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  codeHash  String   // sha256(code)
  channel   String   // "whatsapp"
  expiresAt DateTime
  used      Boolean  @default(false)
  createdAt DateTime @default(now())
}

model Session {
  id           String   @id @default(cuid())
  userId       String
  user         User     @relation(fields: [userId], references: [id])
  tokenHash    String   @unique // sha256(jwt)
  ipAddress    String
  userAgent    String
  status       String   // active | revoked_by_new_login | expired | logged_out
  expiresAt    DateTime
  lastActivity DateTime @default(now())
  createdAt    DateTime @default(now())
}

model VaultAuditLog {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id])
  action    String   // "REVEAL" | "LIST"
  resource  String   // e.g., /myclinicsoft/zapi_token
  ipAddress String
  createdAt DateTime @default(now())
}

model TimelineEvent {
  id        String   @id @default(cuid())
  eventType String
  title     String
  severity  String   // info | warning | critical
  project   String?
  detail    String?
  actor     String
  createdAt DateTime @default(now())
  @@index([createdAt, severity])
}

model MetricSnapshot {
  id            String   @id @default(cuid())
  containerName String
  cpuPercent    Float
  memMb         Float
  memPercent    Float
  createdAt     DateTime @default(now())
  @@index([containerName, createdAt])
}

model AlertLog {
  id        String   @id @default(cuid())
  ruleKey   String
  severity  String
  title     String
  message   String
  channels  String[] // ["whatsapp", "sms"]
  sent      Boolean
  error     String?
  createdAt DateTime @default(now())
  @@index([createdAt])
}

model AlertRule {
  id          String   @id @default(cuid())
  name        String
  condition   Json     // { type: "cpu_above", threshold: 80, duration: "5m" }
  severity    String
  channels    String[]
  cooldownMin Int      @default(30)
  enabled     Boolean  @default(true)
  createdAt   DateTime @default(now())
}

model DeployHistory {
  id          String   @id @default(cuid())
  project     String
  status      String   // success | failed | running
  commitSha   String?
  commitMsg   String?
  author      String?
  duration    Int?     // seconds
  triggeredBy String?  // "manual" | "scheduler" | "user:id"
  startedAt   DateTime
  finishedAt  DateTime?
  @@index([project, startedAt])
}

model ProjectApi {
  id          String   @id @default(cuid())
  project     String   // "myclinicsoft", "fisiomt", ...
  name        String   // "Z-API", "OpenAI", ...
  baseUrl     String
  environment String   // "prod" | "staging" | "dev"
  healthUrl   String?  // ping endpoint
  ssmKey      String?  // /myclinicsoft/zapi_token
  status      String?  // healthy | degraded | down (last check)
  lastChecked DateTime?
  docsUrl     String?
}
```

### 2.5. Fluxo de Auth OTP (espelhando MyClinicSoft)

```
1. POST /auth/request-code { phone }
   → encontra user pelo phone (active=true, blocked=false)
   → gera código 6 dígitos com crypto.randomInt (range 100000-999999)
   → INSERT staff_tokens (codeHash sha256, expiresAt +10min)
   → sendOtpMessage via Z-API (kind="otp", bypass kill-switch)
   → response: { firstName: "João" }
   → RATE LIMIT: 5 tentativas/IP em 15min

2. POST /auth/verify-code { phone, code }
   → SELECT staff_tokens WHERE codeHash = sha256(code) AND used=false AND expires_at > NOW()
   → checkUserAccessSchedule (regras de horário)
   → DETECT concurrent login com IP diferente → security_alert + SMS admin
   → REVOKE sessões ativas anteriores (UPDATE status='revoked_by_new_login')
   → INSERT active_sessions (sessionToken random 32 bytes, hash storage)
   → SET cookie httpOnly + return token
   → mark OTP used=true (anti-replay)

3. Middleware authenticateStaffSession (todas as rotas /api/*)
   → Bearer token from header → sha256 → SELECT active_sessions
   → checa status='active', expires_at > NOW(), user.active && !user.blocked
   → DETECT IP change → security_alerts + SMS admin
   → UPDATE last_activity = NOW()
   → req.staffUser = { id, name, email, profile, sessionId }

4. Re-auth para ações sensíveis (NOVO no v4, não existe no MyClinicSoft)
   → POST /vault/{paramName}/reveal exige header X-Otp-Code
   → backend valida OTP fresh (válido por 5 min após geração)
   → INSERT vault_audit_log (action=REVEAL, resource, ip)
   → response: { value, revealedUntil: now+60s }
```

---

## 3. KPIs ANTES vs DEPOIS — Tabela Comparativa

| Categoria | v3 hoje | v4 alvo | Δ |
|-----------|---------|---------|---|
| **Overview** | 4 KPIs (containers, cpu, ram, alerts) | 12 KPIs (+ uptime%, apps falha/deploy, sites on/off, custo $, heatmap, etc.) | +8 |
| **SRV1** | 4 (cpu/ram/disk/uptime) | 11 (+ load avg, top procs, systemd, journalctl, firewall, rede in/out) | +7 |
| **Coolify** | Status só na tela `projects` | 7 por app (status, healthcheck, cpu/ram, último deploy, env vars ofuscadas, webhooks, portas) | +6 |
| **HestiaCP** | Contas + domínios listados | + ping HTTP, SSL expiry, quota disco/banda, DNS records, visitas | +5 |
| **Vault** | Reveal toggle simples | + agrupado por projeto, re-auth OTP, audit log, dias-desde-rotação | +4 |
| **APIs** | Não existe tela | 7 KPIs por API (status ping, rate limit, consumo, endpoints, docs) | +7 (nova) |
| **Alertas** | Log read-only + teste manual | + CRUD de regras, silence/maintenance window, canais por regra | +5 |
| **Analytics** | Não existe | MTTR, MTBF, comparativos 7/30/90d, exports PDF/CSV | +6 (nova) |
| **Total** | **18 KPIs** | **66+ KPIs** | **+48** |

---

## 4. SKILLS QUE VOU USAR DURANTE A IMPLEMENTAÇÃO

| Skill | Quando |
|-------|--------|
| `myclinicsoft-powerpack:frontend-design-pro` | Polimento visual final das telas (obrigatório segundo o prompt) |
| `high-end-visual-design:high-end-visual-design` | Tipografia + spacing + Double-Bezel cards |
| `myclinicsoft-powerpack:tdd-workflow` | Testes Vitest/Playwright (P0 do prompt) |
| `myclinicsoft-powerpack:security-audit` | Validação final de auth + SSM + reveal flow |
| `myclinicsoft-powerpack:accessibility-audit` | WCAG AA antes do deploy |
| `myclinicsoft-powerpack:performance-optimizer` | TTI < 2s, sem layout shift |
| `myclinicsoft-deploy` (regras CLAUDE.md global) | Deploy DEV → GIT → PROD com `npx tsc --noEmit` |
| `github-devops:github-devops` | PR + commit semântico |
| `coolify-manager:coolify-manager` | Deploy + env vars + restart |
| `hostinger-api:hostinger-guide` | DNS, métricas, snapshots |
| `engineering:system-design` | ADRs para decisões grandes |

---

## 5. ESTRATÉGIA DE COEXISTÊNCIA v3 ↔ v4

- v3 continua em `https://controler.net.br` (não mexo)
- v4 sobe em `https://controler-v4.net.br` (subdomínio novo)
- DNS Cloudflare via MCP automatiza criação
- Coolify recebe nova aplicação `controler-v4` (UUID novo)
- Postgres + Redis em containers separados (data isolada)
- Migração de dados: script one-off que copia `bd/controler.db` → Postgres
- Cutover: quando v4 estiver verde por 7 dias, troca DNS principal e v3 vira `/legacy`

---

## 6. RISCOS E MITIGAÇÕES

| Risco | Probabilidade | Impacto | Mitigação |
|-------|---------------|---------|-----------|
| Quebrar v3 durante migração | Baixa | Alto | Subdomínio separado; v3 intocado |
| Z-API banir número (de novo) | Média | Médio | Replicar `zapi-guard.ts` com kind="otp" bypass |
| Postgres consumir RAM no SRV1 | Baixa | Médio | Container 512MB max; backup S3 |
| SSH HestiaCP timeout | Média | Baixo | Cache Redis 30s + fallback "última leitura há Xmin" |
| Construir MCP HestiaCP atrasar tudo | Alta | Baixo | Adia para v4.1; SSH funciona desde dia 1 |
| Coolify API rate limit | Baixa | Médio | Cache Redis + ETags |
| Não conseguir reproduzir auth MyClinicSoft 1:1 | Baixa | Alto | Já li o código completo; tabelas users/staff_tokens/active_sessions vão para Prisma |

---

## 7. ESTIMATIVA DE ESFORÇO

| Etapa | Tempo Claude | Risco |
|-------|--------------|-------|
| 3. Scaffold + Docker | 1-2h | baixo |
| 4. Integrações (4 providers) | 3-4h | médio (SSH HestiaCP) |
| 5. Auth OTP | 2h | baixo (espelho) |
| 6. Frontend 8 telas | 4-6h | médio (visual) |
| 7. Deploy + DNS | 1h | baixo |
| 8. Docs | 1h | baixo |
| **Total** | **12-16h** | dividido em 2-3 sessões |

---

## DECISÕES PEDIDAS NESTE CHECKPOINT

1. ✅ **Você aprova esta arquitetura?** (Next.js + NestJS + Prisma + Postgres + Redis em monorepo)
2. ✅ **Você aprova esta lista de 66 KPIs?** Quer adicionar/remover algo?
3. ✅ **Subdomínio `controler-v4.net.br`** para coexistência ok? Ou prefere outro?
4. ✅ **Cadastrar você como user inicial:** name="João Henrique", phone="556598466555", email="joaogrigoli1@gmail.com" — confere?
5. ✅ **Acessibilidade WCAG AA + dark mode primário + light mode opcional** ok?

Se aprovar tudo, eu sigo direto para Etapa 3 (scaffold) na próxima mensagem.
Se quiser ajustar algo, me diga e eu re-edito antes de codar.
