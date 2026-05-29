# CLAUDE.md — controler

## Sobre

**controler** — Command Center NOC (Network Operations Center) para gestão centralizada da infraestrutura SRV1.

**Localização:** `~/DEV/controler/`
**Produção:** `https://noc.controler.net.br`
**Coolify UUID:** `a8u2gdchrpjnn6era2i8kh8d`
**Versão:** 4.0.0

## Stack

- **Backend:** Node 20 + NestJS 10 + Fastify + Prisma 5 + Postgres 16 + Redis 7 + Socket.IO
- **Frontend:** Next.js 14 + TypeScript + TailwindCSS + Recharts + Framer Motion
- **Auth:** OTP via WhatsApp (Z-API principal + Meta oficial fallback) ou SMS (Infobip). JWT 15min access + 7d refresh. Re-auth OTP em ações sensíveis.
- **Realtime:** WebSocket (host metrics 30s, container metrics 30s)
- **Infra:** Docker socket + AWS SSM + Coolify API + SSH para SRV1 + Cloudflare DNS

## Estrutura

```
controler/
├── apps/
│   ├── api/         NestJS (REST + WebSocket + BullMQ + Schedulers)
│   │   ├── prisma/  schema + seed
│   │   ├── src/     14 módulos: auth, srv1, coolify, hestia, vault,
│   │   │            alerts, scanner, realtime, timeline, deploys,
│   │   │            apis, analytics, users, common
│   │   └── Dockerfile
│   └── web/         Next.js 14 (App Router)
│       ├── app/     login + 8 telas dashboard
│       ├── components/
│       └── Dockerfile
├── packages/
│   ├── shared/      tipos + Zod schemas
│   └── ui/          design tokens
├── mcps/
│   └── hestia/      MCP server HestiaCP (futuro)
├── docker-compose.yml
└── README.md
```

## 8 Telas

1. **Overview** (`/overview`) — Mission Control: KPIs, gauges SRV1, apps Coolify, timeline, status
2. **SRV1** (`/srv1`) — gauges + histórico 6h + systemd + top procs + ports
3. **Coolify** (`/coolify`) — 7+ apps com status, envs, logs, deploy
4. **Mail & Sites** (`/hestia`) — 15 sites: HTTP, SSL expiry, mail stack
5. **Vault** (`/vault`) — SSM por projeto + reveal com re-auth + audit log
6. **APIs** (`/apis`) — APIs por projeto + ping de saúde
7. **Alertas** (`/alerts`) — CRUD regras + log disparos + teste
8. **Analytics** (`/analytics`) — MTTR + heatmap 24h + comparativos

## Regras de Deploy

```
~/DEV/controler (local) → GitHub (main) → Coolify (prod)
```

1. `npx tsc --noEmit` em apps/api e apps/web → 0 erros
2. `git add` + commit semântico + `git push origin main`
3. `coolify_deploy uuid=a8u2gdchrpjnn6era2i8kh8d force=true`
4. Validar `curl https://noc.controler.net.br/be-health`

**NUNCA editar arquivos direto em srv1.** Sempre DEV → GIT → PROD.

## Convenção de canais (João — IMPORTANTE)

| Canal | Convenção | Providers |
|-------|-----------|-----------|
| **WhatsApp** | SEMPRE 2 rotas | **Z-API** (principal) + **Meta API oficial** (fallback) |
| **SMS** | SEMPRE Infobip | **Infobip** |

Toda mensagem WhatsApp deve tentar Z-API primeiro; se falhar (sessão morta, ban, 4xx),
cai para Meta API oficial. SMS é canal independente, sempre via Infobip.

Implementação: `apps/api/src/auth/whatsapp.service.ts` (OTP) e
`apps/api/src/alerts/alerts.service.ts` (alertas).

## Secrets

Tudo no AWS SSM (profile `cowork-admin`):

- `/controler/coolify_token` — Coolify API
- `/controler/srv1_ssh_password` — SSH SRV1 (fallback se key falhar)
- `/cloudflare/token` — Cloudflare API (zone aa5b42d654cc842a66d931bbf3a64817)
- `/shared/zapi/instance_id` + `/shared/zapi/token` — Z-API WhatsApp (principal)
- `/myclinicsoft/zapi_token`, `/myclinicsoft/zapi_client_token` — Z-API (fallback paths)
- `/myclinicsoft/whatsapp/access_token` + `/myclinicsoft/whatsapp/phone_number_id` — Meta WhatsApp Business API oficial
- `/myclinicsoft/infobip_api_key` + `/shared/infobip/base_url` — SMS Infobip
- `/myclinicsoft/hostinger_api_token` — Hostinger VPS API
- `/myclinicsoft/installers_aws_access_key_id` + `*_secret_access_key` — AWS creds para o container

## Infraestrutura

| Item | Detalhe |
|------|---------|
| **srv1** | VPS Hostinger 62.72.63.18 (KVM 4, 16GB RAM, 200GB disco) — Coolify gerencia |
| **coolify** | UI em `:8000` — API em `http://10.0.6.1:8000` (visto da rede da app) |
| **fail2ban** | whitelist persistida em `/etc/fail2ban/jail.d/docker-whitelist.conf` para 10.0.0.0/8 + 172.16.0.0/12 |
| **SSH key container** | `/data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh/id_ed25519` |
| **dev local** | `pnpm install` + `pnpm dev` (precisa docker-compose para postgres+redis) |

## Subir local

```bash
cd ~/DEV/controler
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm --filter @controler/api prisma:migrate
pnpm --filter @controler/api prisma:seed
pnpm dev
# Frontend: http://localhost:3000
# API: http://localhost:4000
```

## Documentação

- `README.md` — visão geral + setup
- `ARCHITECTURE.md` — stack + diagrama Mermaid + auth flow
- `RUNBOOK.md` — operação (healthcheck, deploys, rollback, recuperar acesso)
- `COMPARISON.md` — KPIs antes (v3 antigo) vs depois (66+ KPIs)
- `SRV1_INVENTORY.md` — 41 containers documentados no SRV1
- `SETUP_GUIDE.md` — passos de setup + secrets + DNS
