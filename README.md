# Controler v4 — NOC

Sistema NOC profissional para gestão centralizada da infraestrutura SRV1.

**Stack**: Next.js 14 + NestJS + Prisma + PostgreSQL + Redis + Socket.IO

**Subdomínio (planejado)**: https://controler-v4.net.br

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

- `_docs-antigos/CHECKPOINT_1_AUDITORIA.md` — auditoria + arquitetura
- `apps/api/prisma/schema.prisma` — modelo de dados
- `ARCHITECTURE.md` — decisões técnicas (gerado na Etapa 8)
- `RUNBOOK.md` — operação e incident response (gerado na Etapa 8)
