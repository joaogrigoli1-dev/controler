# AGENTS.md — controler

> **Fonte ÚNICA das instruções deste projeto para qualquer agente** (Claude Code, Claude
> Desktop/Cowork, Codex). O `CLAUDE.md` da raiz só importa este arquivo (`@AGENTS.md`): regra
> nova entra **aqui**, nunca lá. Unificado em 21/09/2026 (cópias anteriores em
> `~/Dev/_lixo-2026-09-19/projetos/controler/instrucoes-antes-2026-09-21/` e no histórico git).
> **As regras globais (`~/.claude/CLAUDE.md`, fonte única; o Codex lê a cópia gerada
> `~/.codex/AGENTS.md`) PREVALECEM sobre este arquivo em qualquer conflito/duplicação.**
> Fluxo de deploy, credenciais (SSM), idioma, autonomia e qualidade: ver o global. Aqui só o específico.

## Projeto

- Command Center NOC (Network Operations Center) para gestão centralizada da infraestrutura SRV1
  (62.72.63.18). **Local:** `~/Dev/controler` | **Prod:** https://noc.controler.net.br | **UUID Coolify:** `a8u2gdchrpjnn6era2i8kh8d` | v4.0.0
- **Stack:** NestJS 10 + Fastify + Prisma 5 + Postgres 16 + Redis 7 + Socket.IO | Next.js 14 (App Router) + Tailwind + Recharts
- **Monorepo pnpm:** `apps/api`, `apps/web`, `packages/shared` (tipos+Zod — fonte única), `packages/ui`
- **Auth:** OTP via WhatsApp ou SMS; JWT 15min access + 7d refresh; re-auth OTP em ações sensíveis
- Contrato Zod das telas em `apps/web/lib/schemas.ts` — front e back derivam dali

## Deploy — particularidades (fluxo geral no global)

- Typecheck: `npx tsc --noEmit` em `apps/api` **E** `apps/web`
- Health pós-deploy: `curl https://noc.controler.net.br/be-health` (health check do Coolify está
  desabilitado — validação manual obrigatória)

## Canais de mensagem (convenção João)

- **WhatsApp:** SEMPRE 2 rotas — Z-API principal (`/shared/zapi/*`); se falhar (sessão morta, ban, 4xx),
  fallback Meta API oficial (`/myclinicsoft/whatsapp/*`)
- **SMS:** SEMPRE Infobip (`/shared/infobip/*`)
- Implementação: `apps/api/src/auth/whatsapp.service.ts` (OTP) e `apps/api/src/alerts/alerts.service.ts` (alertas)

## Específicos de infra

- **SRV1 (hardware real):** KVM8 — 8 vCPU / 32 GB RAM / 400 GB disco, Ubuntu 24.04
- **SSH SRV1:** porta **47391** (via SSM `/shared/srv1/port`, fallback 22); chave via SSM
  `/shared/srv1/private_key_path`
- **Containers:** contagem dinâmica (~33-34) — não afirmar número fixo
- Coolify API visto de dentro da app: `http://10.0.6.1:8000`
- SSH key do container: `/data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh/id_ed25519`
- Coletores raw a cada 60s (env `NOC_RAW_INTERVAL_MS`); chave SSH do coletor = `/root/.ssh/id_ed25519`
  (mount do Coolify) com env `SRV1_SSH_KEY_PATH` apontando para ela
- fail2ban: whitelist em `/etc/fail2ban/jail.d/docker-whitelist.conf` (10.0.0.0/8 + 172.16.0.0/12)
- Secrets consumidos: SSM `/controler/*`, `/shared/*`, `/cloudflare/*`, `/myclinicsoft/whatsapp/*`,
  `/myclinicsoft/infobip_api_key` — **fonte da verdade é o SSM** (não duplicar listas aqui)

## Subir local

`pnpm dev` (web :3000 | api :4000). Passo a passo no `README.md`.

## Documentação

`README.md` · `ARCHITECTURE.md` · `RUNBOOK.md` (operação/rollback) · `SETUP_GUIDE.md` (secrets/DNS)
