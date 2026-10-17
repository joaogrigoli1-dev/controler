# Controler v4 — NOC

Sistema NOC profissional para gestão centralizada da infraestrutura SRV1.

**Stack**: Next.js 14 + NestJS + Prisma + PostgreSQL + Redis + Socket.IO

**Produção**: https://controler.net.br · https://noc.controler.net.br

## Estrutura

```
v4/
├── apps/
│   ├── api/    NestJS (REST + WebSocket + BullMQ workers)
│   └── web/    Next.js 14 (App Router)
├── packages/
│   ├── shared/ Tipos + Zod schemas compartilhados
│   └── ui/     Design tokens
├── mcps/
│   └── hestia/ MCP HestiaCP (futuro)
├── docker-compose.yml
└── README.md
```

## Setup local

```bash
cd v4
cp .env.example .env
pnpm install
pnpm prisma:migrate
pnpm prisma:seed   # cadastra João como user inicial
pnpm dev
```

Frontend: http://localhost:3000
API: http://localhost:4000
Postgres: localhost:5432
Redis: localhost:6379

## Deploy

```bash
docker-compose up -d --build
```

Em produção (Coolify) a app é nova: `controler-v4`.
Apontar Coolify para `v4/docker-compose.yml` como tipo "Docker Compose".

## Auth

OTP WhatsApp via Z-API (espelhado do MyClinicSoft):
1. POST `/auth/request-code` { phone } → envia código WhatsApp
2. POST `/auth/verify-code` { phone, code } → retorna JWT
3. Header `Authorization: Bearer <token>` em todas as rotas /api/*
4. Re-auth OTP obrigatório em ações sensíveis (reveal vault, redeploy prod)

## Documentação

Vivos, na raiz:

- `ARCHITECTURE.md` — decisões técnicas
- `RUNBOOK.md` — operação, rollback e incident response
- `SETUP_GUIDE.md` — secrets e DNS
- `AGENTS.md` — instruções do projeto para qualquer agente (o `CLAUDE.md` só importa este)
- `apps/api/prisma/schema.prisma` — modelo de dados

Em `docs/`:

- `docs/SINC-PANEL-CONTRACT.md` — contrato, fronteira e validação do painel `/sinc`
- `docs/decisoes/` — registros de decisão ainda vigentes
- `docs/incidentes/` — incidentes cuja mitigação continua em produção
- `docs/auditorias/` — laudos de auditoria
- `docs/infra/` — inventário do SRV1
- `docs/historico/` — fases, plano e relatório final do projeto NOC (referência, não contrato)
