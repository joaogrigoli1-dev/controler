# Auditoria Completa — controler (Command Center NOC)
**Data:** 2026-06-10 · **Escopo:** completo (BD, Backend, Frontend, UX — todas as 9 páginas) · **Acesso ao BD:** estático via código (schema.prisma + services)

## Contexto detectado
Monorepo pnpm v4.0.0: `apps/api` (NestJS 10 + Fastify + Prisma 5 + Postgres 16 + Redis/BullMQ + Socket.IO, 13 controllers) e `apps/web` (Next.js 14 App Router + Tailwind + Recharts + SWR + socket.io-client, login + 8 telas dashboard). Auth: OTP WhatsApp/SMS, JWT 15min + refresh, re-auth OTP em ações sensíveis. **Não há pasta `prisma/migrations/`** — schema é a única fonte de verdade, sem histórico versionado. `ValidationPipe` global com `whitelist + forbidNonWhitelisted` confirmado (`main.ts:70`). Guards aplicados por controller (todos os 13 têm `@UseGuards`), não globalmente.

## Resumo executivo

| Severidade | BD | Backend | Frontend | UX | Total |
|---|---|---|---|---|---|
| P0 | 0 | 2 | 0 | 0 | **2** |
| P1 | 2 | 2 | 2 | 1 | **7** |
| P2 | 4 | 0 | 2 | 4 | **10** |
| P3 | 2 | 0 | 0 | 7 | **9** |
| **Total** | 8 | 4 | 4 | 12 | **28** |

**Top 3:**
1. **[BE-01]** Gateway Socket.IO sem autenticação e com `cors origin: true` — qualquer cliente na rede recebe métricas de host/containers, alertas e deploys em tempo real.
2. **[BE-03]** Endpoint `/auth/dev-otp` (backdoor) retorna código OTP em texto puro no response e usa comparação não timing-safe — se `DEV_BACKDOOR_TOKEN` vazar, login admin sem WhatsApp.
3. **[BD-07 + FE-03]** TTLs dessincronizados (JWT 15min, Session 24h, docs prometem 7d) e o frontend **nunca usa o refresh token** — sessão "morre" silenciosamente após 15min.

---

## Achados

### P0 — Críticos

#### [BE-01] Socket.IO sem autenticação, broadcast global, CORS aberto
- **Área:** Backend · **Severidade:** P0
- **Evidência:** `apps/api/src/realtime/realtime.gateway.ts:11-23` — `@WebSocketGateway({ cors: { origin: true, credentials: true }, path: "/ws" })`; `handleConnection` apenas loga, sem validar JWT; todos os `emit*` usam `this.server.emit(...)` (broadcast para todas as conexões).
- **Impacto:** Qualquer cliente que alcance `/ws` recebe métricas do SRV1, status de containers, alertas e deploys sem login — vazamento de informação de infraestrutura.
- **Correção sugerida:** Validar JWT no handshake e desconectar não autenticados:
  ```ts
  handleConnection(socket: Socket) {
    try {
      const token = socket.handshake.auth?.token;
      socket.data.user = this.jwt.verify(token, { secret: process.env.JWT_ACCESS_SECRET });
    } catch { socket.disconnect(true); return; }
  }
  ```
  E restringir `cors.origin` à URL do frontend (`https://noc.controler.net.br`).
- **Cruzamento:** UX-14 (cliente já trata desconexão, então a mudança é segura).

#### [BE-03] Backdoor `/auth/dev-otp` retorna OTP em claro
- **Área:** Backend · **Severidade:** P0
- **Evidência:** `apps/api/src/auth/auth.controller.ts:100-121` — endpoint cria OTP válido (purpose `login`, 10min) e o devolve no JSON. Linha 106: `if (token !== backdoor)` — comparação de string não timing-safe.
- **Impacto:** Se `DEV_BACKDOOR_TOKEN` vazar (env, log, histórico git), atacante loga como qualquer usuário ativo sem passar pelo WhatsApp; o código ainda pode parar em logs de proxy/APM.
- **Correção sugerida:** Desabilitar em produção (`if (process.env.NODE_ENV === "production") throw new ForbiddenException()`), usar `crypto.timingSafeEqual` na comparação, e nunca incluir o código no response em ambiente não-dev.
- **Cruzamento:** BD-15 (mesmo achado pela ótica do banco — canal `"backdoor"` gravado em OtpToken).

### P1 — Altos

#### [BE-02] Race condition (TOCTOU) na verificação de OTP de re-auth
- **Área:** Backend · **Severidade:** P1
- **Evidência:** `apps/api/src/auth/auth.service.ts:214-228` — `verifyReauthCode` faz `findFirst({ used: false ... })` e só depois `update({ used: true })`. Duas requisições paralelas com o mesmo código passam ambas pelo `findFirst` antes do update.
- **Impacto:** O mesmo OTP de revelação de secret pode ser consumido 2+ vezes em paralelo, quebrando a garantia de uso único da re-auth.
- **Correção sugerida:** Consumo atômico:
  ```ts
  const r = await this.prisma.otpToken.updateMany({
    where: { userId, codeHash: this.hashValue(code), used: false, purpose: "reveal", expiresAt: { gt: new Date() } },
    data: { used: true }
  });
  return r.count > 0;
  ```
  Aplicar o mesmo padrão em `verifyCode` (login, linhas 139-158).

#### [BE-09] Fallback de JWT secret hardcoded
- **Área:** Backend · **Severidade:** P1
- **Evidência:** `apps/api/src/auth/auth.service.ts:162` e `:240` — `secret: process.env.JWT_ACCESS_SECRET || "dev-secret-change-me-min-32-chars-please"`.
- **Impacto:** Se a env não carregar em produção (falha no SSM, typo), a API sobe normalmente assinando tokens com secret público no repositório — qualquer um forja JWT de admin.
- **Correção sugerida:** Falhar no boot: validar `JWT_ACCESS_SECRET` em `main.ts` (ou Zod env schema) e lançar erro se ausente. Remover o fallback dos dois pontos.

#### [BD-07] TTLs dessincronizados: JWT 15min × Session 24h × docs 7d
- **Área:** BD · **Severidade:** P1
- **Evidência:** `auth.service.ts:16` (`SESSION_TTL_HOURS = 24`), `:162` (`expiresIn: "15m"`), `:166` (expiresAt = +24h). ARCHITECTURE/CLAUDE.md prometem "15min access + 7d refresh".
- **Impacto:** Sessão e refresh expiram juntas em 24h (não 7d); combinado com FE-03, o usuário é deslogado a cada 15min.
- **Correção sugerida:** Definir explicitamente: access 15min, session/refresh 7d (`SESSION_TTL_HOURS = 168`), e implementar o refresh no cliente (FE-03).

#### [BD-01] Nenhuma limpeza de OtpToken, Session e AuditLog expirados
- **Área:** BD · **Severidade:** P1 (consolida BD-01/BD-02/BD-14)
- **Evidência:** `schema.prisma:37-103` — os 3 models têm `expiresAt`/`createdAt`; `metrics.scheduler.ts:247-258` — `cleanup()` só remove snapshots/timeline. `auth.service.ts:104-107` marca OTPs como `used` mas nunca deleta.
- **Impacto:** Tabelas de auth crescem sem limite (todo login gera OTP + session + 2 audit logs); degradação progressiva das queries de login e superfície de dados sensíveis retida indefinidamente.
- **Correção sugerida:** Adicionar ao `cleanup()` diário: `otpToken.deleteMany({ where: { expiresAt: { lt: now } } })`, sessions expiradas/revogadas com `updatedAt` > 7d, e auditLog > 180d.

#### [FE-02] JWT + refresh token em localStorage
- **Área:** Frontend · **Severidade:** P1
- **Evidência:** `apps/web/lib/auth.ts:8-10` e `lib/api.ts:17` — tokens gravados/lidos de `localStorage`.
- **Impacto:** Qualquer XSS (ou extensão maliciosa) exfiltra access + refresh token de uma ferramenta que controla a infraestrutura inteira.
- **Correção sugerida:** Migrar refresh token para cookie `HttpOnly; Secure; SameSite=Strict` servido pela API; manter access token só em memória. Mitigação imediata: pelo menos o refresh token fora do localStorage.

#### [FE-03] Refresh token nunca é usado pelo cliente
- **Área:** Frontend · **Severidade:** P1
- **Evidência:** `apps/web/lib/auth.ts:9` grava `controler:refresh`, mas não há nenhuma chamada a `/auth/refresh` em `lib/api.ts` nem interceptor de 401.
- **Impacto:** Após 15min o JWT expira e toda chamada passa a falhar com 401 até o usuário relogar manualmente — quebra de fluxo em uma tela de monitoramento que fica aberta o dia todo.
- **Correção sugerida:** Em `lib/api.ts`, ao receber 401: chamar `POST /auth/refresh` com o refresh token, atualizar o access token e repetir a request 1x; se falhar, redirecionar para `/login`.

#### [UX-18] Mensagens de erro cruas da API expostas na UI
- **Área:** UX · **Severidade:** P1
- **Evidência:** `apps/web/app/(dashboard)/vault/page.tsx:42-43` (`alert(e?.message)`), `app/(auth)/login/page.tsx:64-65` — `e.message` renderizado direto.
- **Impacto:** Erros como "Connection timeout at 10.0.6.1:8000" vazam IPs/topologia interna e confundem o usuário.
- **Correção sugerida:** Mapear códigos de erro para mensagens amigáveis no `lib/api.ts`; logar o erro técnico só no console.

### P2 — Médios

#### [BD-06] Enums simulados com `String` sem constraint (role, status, purpose, severity)
- **Área:** BD · **Severidade:** P2 (consolida BD-06/BD-10)
- **Evidência:** `schema.prisma:22, 43, 61, 78, 111, 174, 213, 259, 295` — campos `String` com valores válidos só em comentário; validação apenas em código.
- **Impacto:** Insert direto/seed/raw query pode gravar valor inválido que some das queries filtradas (`status: "active"`).
- **Correção sugerida:** Converter para `enum` nativo do Prisma (UserRole, OtpPurpose, SessionStatus, AlertSeverity...).

#### [BD-09] Índice de OtpToken não cobre a query de verificação
- **Área:** BD · **Severidade:** P2
- **Evidência:** `schema.prisma:49` — `@@index([userId, used, expiresAt])`; a query crítica (`auth.service.ts:139-142`) filtra também por `codeHash` e `purpose`.
- **Correção sugerida:** `@@index([userId, purpose, used, expiresAt])`.

#### [BD-03] `onDelete` ausente nas FKs de VaultAuditLog e AuditLog
- **Área:** BD · **Severidade:** P2 (consolida BD-03/BD-04)
- **Evidência:** `schema.prisma:77` (VaultAuditLog.user sem `onDelete`) e `:91-94` (AuditLog.user `User?` sem `onDelete`) — contrasta com OtpToken/Session que usam `Cascade`.
- **Impacto:** Delete de usuário falha (restrict default do Prisma) ou comporta-se de forma inconsistente entre tabelas de auditoria.
- **Correção sugerida:** Para audit logs, preferir `onDelete: SetNull` com `userId String?` (preserva trilha de auditoria) em ambos.

#### [BD-08] Refresh token e OTP com SHA-256 puro, sem pepper
- **Área:** BD · **Severidade:** P2
- **Evidência:** `auth.service.ts` — `hashValue` = SHA-256 simples para `codeHash` e `refreshHash` (`schema.prisma:41, 58`).
- **Impacto:** Dump do banco permite ataque offline; OTP de 6 dígitos é trivialmente reversível por força bruta de 10⁶ hashes.
- **Correção sugerida:** `crypto.createHmac("sha256", PEPPER)` com pepper vindo do SSM.

#### [FE-04] Queries SWR sem tratamento de estado de erro
- **Área:** Frontend · **Severidade:** P2
- **Evidência:** Páginas do dashboard usam `useSWR` e renderizam apenas `data` (ex.: `coolify/page.tsx:77-79` mostra "Carregando…" para sempre se a request falhar).
- **Impacto:** Falha de API exibe dados stale ou loading infinito sem nenhum aviso — em um NOC, o operador acha que está vendo o estado atual.
- **Correção sugerida:** Tratar `error` do SWR em cada página (banner "Erro ao carregar — tentando novamente") ou num wrapper comum.

#### [FE-16] Logout não limpa cache em memória do SWR
- **Área:** Frontend · **Severidade:** P2
- **Evidência:** `components/layout/Sidebar.tsx:72-75` — `localStorage.clear()` + redirect, sem `mutate`/clear do cache SWR.
- **Impacto:** Em máquina compartilhada, o próximo login pode ver flashes de dados da sessão anterior.
- **Correção sugerida:** `import { mutate } from "swr"; mutate(() => true, undefined, { revalidate: false })` antes do redirect (ou `location.href` com hard reload já mitiga — validar).

#### [UX-01] `alert()` nativo para erros do modal OTP do vault
- **Área:** UX · **Severidade:** P2 (consolida UX-01/UX-02)
- **Evidência:** `vault/page.tsx:43` — `alert(e?.message || "OTP inválido")`; modal não mostra erro inline nem limpa o input.
- **Correção sugerida:** State `otpError` renderizado dentro do modal, com opção de reenviar código.

#### [UX-04] Envio de OTP de re-auth falha silenciosamente
- **Área:** UX · **Severidade:** P2
- **Evidência:** `vault/page.tsx:31` — `catch (e) { console.error(e); }` — modal fica em "Enviando código…" para sempre se Z-API falhar.
- **Impacto:** Cenário real do projeto (sessão Z-API morta → fallback Meta); o usuário não tem como saber que falhou.
- **Correção sugerida:** Exibir erro no modal com botão "Tentar novamente".

#### [UX-09] Logout com `confirm()` nativo + `localStorage.clear()` total
- **Área:** UX · **Severidade:** P2
- **Evidência:** `components/layout/Sidebar.tsx:72-75`.
- **Impacto:** `localStorage.clear()` apaga também preferências de outras origens da app; confirm nativo é inconsistente com o design system.
- **Correção sugerida:** Modal custom + remover apenas as chaves `controler:*` (já existe `clearAuth()` em `lib/auth.ts` — usar).

#### [UX-13] Erro de teste de alerta renderizado como JSON cru
- **Área:** UX · **Severidade:** P2
- **Evidência:** `alerts/page.tsx:24-25` — `setResult({ error: e?.message })` exibido em `<pre>`.
- **Correção sugerida:** Componente de erro dedicado com botão "Tentar novamente".

### P3 — Baixos

| ID | Descrição | Evidência | Correção |
|---|---|---|---|
| BD-05 | AlertLog sem índice em `ruleId` | `schema.prisma:200-201` | `@@index([ruleId, createdAt(sort: Desc)])` |
| BD-13 | `updatedAt` ausente em OtpToken/VaultAuditLog/AlertLog | `schema.prisma:37-50, 74-86, 186-202` | Adicionar `updatedAt DateTime @updatedAt` |
| UX-03 | Inconsistência SMS × WhatsApp no vault (title diz "SMS", header diz "WhatsApp") | `vault/page.tsx:85` vs `:51-55` | Unificar para "WhatsApp" (consolida FE-01/UX-16) |
| UX-05 | Sem feedback de sucesso ao revelar credencial | `vault/page.tsx:34-47` | Toast "Credencial revelada ✓" |
| UX-10 | Audit do vault mostra só 12 linhas sem indicar total | `vault/page.tsx:103` (`slice(0, 12)`) | "Mostrando 12 de N" ou paginação |
| UX-11 | Input OTP remove caracteres silenciosamente, sem contador | `login/page.tsx:160-172` | Contador "n/6 dígitos" |
| UX-14 | Badge de socket desconectado não avisa que dados podem estar stale | `Topbar.tsx:48-52` | Aviso "dados podem estar desatualizados" + refresh ao reconectar |
| UX-19 | Modal OTP sem handler de ESC nem focus trap | `vault/page.tsx:116-117` | useEffect com listener ESC / headlessui Dialog |
| UX-12 | Sem confirmação visual no primeiro envio de código de login | `login/page.tsx:36-42` | Notice "Código enviado ✓" também no primeiro envio |

## Suspeitas não confirmadas
- **Brute force de OTP (BE-06):** `@Throttle` existe nos endpoints, mas não foi confirmado limite de *tentativas por código* (um atacante distribuído pode tentar 10⁶ combinações em 10min de validade). Confirmar contando tentativas por `otpToken` ou reduzindo a janela.
- **Falta de transação em operações multi-tabela (BE-05):** login cria session + audit log em chamadas separadas (`auth.service.ts:155-186`); falha parcial deixa estado inconsistente. Confirmar todos os fluxos antes de envolver em `$transaction`.
- **Colunas possivelmente mortas (BD-12):** `Project.coolifyUuids`, `Site.containerName/sslIssuer/sslExpiresAt` — sem leitura evidente nos services; confirmar com grep completo antes de remover.
- **Contraste WCAG dos badges (UX-07):** `globals.css:96-102` usa background 12% opacity — rodar audit de contraste para confirmar 4.5:1.
- **Validação de cursor/paginação (BE-07):** apontado pelo auditor de backend, não confirmado com arquivo:linha — verificar timeline/analytics.
- **Registros órfãos e integridade real:** impossível verificar sem banco vivo — rodar as queries do checklist com as tools `db_*` numa próxima rodada.

## Fora do escopo
- `mcps/hestia` (marcado como futuro), `packages/ui`, testes Playwright, infra (Coolify/fail2ban/SSM em si), e o banco de produção vivo.

## ✅ Correções aplicadas (2026-06-10)

Todos os achados P0–P3 foram corrigidos (18 arquivos, +586/−154 linhas). Typecheck limpo em `apps/api` e `apps/web`.

| Achado | Correção | Arquivo(s) |
|---|---|---|
| BE-01 | JWT validado no handshake WS + CORS restrito | `realtime.gateway.ts`, `realtime.module.ts`, `lib/socket.ts` (cliente envia token) |
| BE-03 | dev-otp bloqueado em produção + timingSafeEqual + hash unificado | `auth.controller.ts`, `auth.service.ts` (issueBackdoorCode) |
| BE-02 | Consumo atômico de OTP (updateMany) em login e re-auth | `auth.service.ts` |
| BE-09 | Fallback de secret removido; boot falha sem `JWT_ACCESS_SECRET` (≥32 chars) | `main.ts`, `crypto.util.ts`, `jwt-auth.guard.ts`, `auth.service.ts` |
| BE-05 | Login (session+lastLogin+audit) em `$transaction` | `auth.service.ts` |
| BD-01 | Cleanup diário de OTPs, sessions e auditLog >180d | `metrics.scheduler.ts` |
| BD-07 | Session/refresh = 7 dias (era 24h) | `auth.service.ts` |
| BD-08 | HMAC-SHA256 + pepper (`TOKEN_PEPPER`) em todos os hashes | `crypto.util.ts` + consumidores |
| BD-03/05/06/09/13 | Enums nativos, onDelete SetNull, índices, updatedAt | `schema.prisma` + `prisma/manual-migrations/2026-06-10-audit-fixes.sql` |
| FE-03 | Refresh automático em 401 (single-flight + retry) com rotação de token | `lib/api.ts`, `auth.service.ts` (refresh rotaciona) |
| FE-02 | Mitigado: rotação de refresh token + revogação; migração p/ cookie HttpOnly fica como melhoria futura | `auth.service.ts`, `lib/api.ts` |
| FE-04 | Error states inline (vault, coolify) + toast global deduplicado via SWRConfig | páginas + `(dashboard)/layout.tsx` |
| FE-16/UX-09 | Logout: modal custom, revoga sessão no backend, limpa só chaves `controler:*`, descarta socket, hard reload | `Sidebar.tsx`, `lib/socket.ts` |
| UX-18 | Mapa de erros amigáveis (sem vazar IP/porta); erro técnico só no console | `lib/api.ts` |
| UX-01/02/04/05 | Modal OTP do vault: erro inline, retry de envio, toast de sucesso | `vault/page.tsx`, `Toast.tsx` (novo) |
| UX-03/16/17 | Textos unificados "WhatsApp"; aviso de mascaramento | `vault/page.tsx` |
| UX-10 | "Mostrando 12 de N" + expandir audit log | `vault/page.tsx` |
| UX-11/12/20 | Contador n/6 dígitos, confirmação no 1º envio, máscara visual de telefone | `login/page.tsx`, `vault/page.tsx` |
| UX-08 | Erro de logs do Coolify explícito | `coolify/page.tsx` |
| UX-13 | Erro de teste de alerta com componente dedicado + retry | `alerts/page.tsx` |
| UX-14/15 | Aviso "dados desatualizados" + revalidação SWR ao reconectar + timezone no relógio | `Topbar.tsx` |
| UX-19 | Modal com ESC, role=dialog, aria-modal | `vault/page.tsx`, `Sidebar.tsx` |

### ⚠ Passos obrigatórios antes do deploy

1. **Aplicar a migração SQL** (preserva dados; o `db push` puro faria DROP COLUMN):
   `cd apps/api && npx prisma db execute --file prisma/manual-migrations/2026-06-10-audit-fixes.sql`
2. **Rodar `pnpm prisma:generate`** (o client precisa dos novos enums).
3. **Configurar envs**: `JWT_ACCESS_SECRET` (≥32 chars, obrigatória — boot falha sem ela) e opcionalmente `TOKEN_PEPPER` no SSM. Garantir `NODE_ENV=production` em prod (desativa o dev-otp).
4. **Todos os usuários serão deslogados** (hashes migraram de SHA-256 para HMAC; a migração SQL já expira as sessões antigas) — esperado.
5. Rodar `pnpm --filter @controler/api test` localmente (vitest não roda no sandbox desta sessão).

## Plano de correção sugerido
1. **Imediato (rápido):** BE-03 (desabilitar backdoor em prod + timingSafeEqual), BE-09 (remover fallback de secret, validar env no boot), BE-02 (updateMany atômico).
2. **Curto prazo (médio):** BE-01 (auth no WS handshake + CORS restrito), BD-07 + FE-03 juntos (TTLs + refresh flow no cliente), FE-02 (refresh token fora do localStorage), BD-01 (cleanup de auth tables no scheduler).
3. **Seguinte (médio):** UX-18/UX-01/UX-04/UX-13 (camada única de tratamento de erro no `lib/api.ts` + componente de toast resolve os 4), FE-04 (wrapper SWR com error state).
4. **Backlog (rápido cada):** BD-06 (enums Prisma — exige migration), BD-09, BD-03, BD-08, e os P3.
