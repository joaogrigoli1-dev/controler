# controler v4 — Incidente SRV1 + Auditoria Fase 0 + Mapa de Migração

**Data:** 2026-06-15 · **Autor:** sessão Cowork (diagnóstico ao vivo + auditoria estática)
**Status:** Fase 0 concluída. **Nenhum código foi alterado.** Aguardando aprovação para Fase 1.

> ⚠️ Este documento tem 3 partes: (1) o **incidente** que está travando o SRV1 agora, (2) a **auditoria Fase 0** do código, (3) o **mapa de migração** faseado. As partes 2 e 3 atendem ao seu prompt de refatoração; a parte 1 é o problema operacional urgente.

---

## PARTE 1 — INCIDENTE: SRV1 travando (CPU + I/O)

### 1.1 Sintomas confirmados ao vivo

| Métrica | Valor observado | Normal |
|---|---|---|
| Load average (1/5/15min) | **178 / 164 / 98** e subindo | ≤ 4 (4 vCPU) |
| CPU (provider Hostinger) | **~100%** | — |
| Processos em D-state (I/O wait) | **40** (quase todos `runc exec`) | ~0 |
| Processos zumbis | **37** | 0 |
| Uptime no momento | ~22 min (servidor **auto-reiniciou** sozinho) | — |
| RAM | 3,2 GB usados / 16 GB | ok |
| Disco | 71 GB / 193 GB (37%) | ok |
| Tráfego edge (provider) | ~2 MB out / ~2–8 MB in | baixo (não é DDoS externo) |

### 1.2 Causa raiz — é **sistêmica**, não só o container controler

O SRV1 (Hostinger KVM4: **4 vCPU / 16 GB / disco único**) roda **~41 containers** + serviços de host. O que está acontecendo é um **colapso de I/O com "tempestade de healthchecks"**:

1. O disco único satura de I/O.
2. Cada um dos ~41 containers tem healthcheck → Docker dispara `runc exec` a cada poucos segundos.
3. Com I/O saturado, esses `runc exec` **não completam** e empilham em D-state (vi 40 presos).
4. Load explode (processos em D contam no load average) → tudo fica mais lento → mais execs empilham. **Loop de realimentação.**

**Maiores consumidores de CPU/I/O no topo (`ps` ao vivo):**

- `cadvisor` ~24% (monitoramento de containers do Coolify)
- `clamd` (ClamAV) ~14% — antivírus varrendo, CPU+I/O alto
- `policyd-spf` ~22% + ~13% (filtro anti-spam do Postfix)
- `php artisan app:init` ~21% (algum app Laravel inicializando em loop)
- `uvicorn`/FastAPI (PID 4396, **4 workers** + forks de multiprocessing) — outro app
- `dockerd` ~17%, `traefik` ~10%, `promtail` ~8%
- **`find / -xdev -name '*s-server*'`** varrendo o disco inteiro (PID 2589) — **gerador pesado de I/O, origem desconhecida** ⚠️
- `[node] <defunct>` — zumbi do node

> O app **controler** aparece como `node dist/index.cjs` a **~9% de CPU**. Em CPU bruta ele **não é o vilão principal** — é tanto vítima (o healthcheck dele está entre os `runc exec` presos) quanto **amplificador** (ver 1.3).

**Dois fatos que descartam as soluções fáceis:**

- O servidor **já reiniciou sozinho há ~20 min e o load voltou a 178 em 19 min** → **reboot puro NÃO resolve**.
- A VPS está com **`actions_lock: locked`** na Hostinger → reboot via API é recusado agora.

### 1.3 Contribuição do app controler (achados de código)

O NOC tem um agravante real, no código:

- **`metrics.scheduler.ts`** roda, **a cada 60s**, `container-metrics` e `host-metrics`. O `container-metrics` chama `srv1.getContainers()`, que faz **SSH no próprio host** e executa:
  ```
  docker ps -a --format '{{json .}}' && docker stats --no-stream --format '{{json .}}'
  ```
  `docker stats --no-stream` lê cgroups de **todos os 41 containers** — pesado, e a cada minuto.
- **Sem guarda de sobreposição (overlap guard):** se um tick demora mais que 60s (provável com host lento), o próximo dispara mesmo assim → execs de docker empilhando.
- **`common/ssh.service.ts` — bug:** `exec()` recebe `timeoutMs` mas **nunca repassa para `execCommand`**. Ou seja, **o timeout de SSH é ignorado**. Quando o `docker stats` trava no host saturado, a chamada **fica presa para sempre**, segura a conexão SSH no pool e compete por canais do sshd.
- O próprio header do `ssh.service.ts` já documenta um problema anterior: *"sshd começava a recusar com 'Channel open failure' após algumas dezenas de conexões"*. **É exatamente por isso que minhas próprias sessões SSH de diagnóstico também não conseguem canal agora.**

**Conclusão:** o controler amplifica o colapso (polling SSH+docker sem timeout e sem backpressure), mas o estopim sistêmico é **container demais em disco único + clamav + cadvisor + o `find` misterioso**.

### 1.4 Sobre a sua hipótese ("logs travando tudo")

Parcialmente correta e vale corrigir de qualquer forma: o **`docker-compose.yml` não tem rotação de log nem limite de recursos** (sem `logging.max-size`/`max-file`, sem `deploy.resources`/`mem_limit`/`cpus`). Logs de container crescem **sem limite** (driver json-file padrão). Não consegui medir o tamanho real dos logs (o `du` travou no disco saturado), mas a **falta de rotação é um buraco real** e a correção é no **daemon do Docker** (vale para os 41 containers de uma vez).

### 1.5 Mitigações — tentadas, prontas e bloqueio atual

**O que tentei aplicar ao vivo (reversível, em background via SSH):** matar o `find`, parar ClamAV, `renice`/`ionice` no cadvisor. **Não consegui confirmar** se pegaram — o box não devolve mais shell (sshd sem canal).

**Bloqueio atual:** SSH não mantém sessão (load 178), Coolify API expira (roda no mesmo box), Hostinger com `actions_lock`. Por isso as mitigações abaixo estão **prontas para colar** assim que houver acesso (por mim, ou por você direto no painel/console da Hostinger).

#### A) Imediatas no host (alívio de CPU/I/O) — reversíveis
```bash
# 1. Matar a varredura de disco que ninguém pediu (find read-only, seguro matar)
pkill -9 -f 'find / '

# 2. Parar ClamAV (antivírus) — libera CPU+I/O; reversível
systemctl stop clamav-daemon clamav-freshclam clamav-daemon.socket

# 3. Rebaixar prioridade dos scanners pesados (não essenciais p/ operar)
for p in $(pgrep -f cadvisor) $(pgrep -f promtail) $(pgrep -f policyd-spf); do
  renice +19 -p "$p"; ionice -c3 -p "$p"
done

# 4. Reapear zumbis acontece sozinho quando o I/O liberar; conferir:
cat /proc/loadavg
```
> ⚠️ Investigar a origem do `find / -name '*s-server*'` (cron? container? indício de comprometimento?). O padrão é incomum — vale `grep -r 's-server' /etc/cron* /var/spool/cron` e checar de qual container/serviço veio.

#### B) Controle de logs — no daemon do Docker (a sua pedida, na camada certa)
```bash
# /etc/docker/daemon.json  (cria/edita)
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "live-restore": true
}
# aplicar (reinicia o dockerd; com live-restore os containers seguem de pé):
systemctl restart docker
```
> Isso cria rotação para **todos** os containers (10 MB × 3 = 30 MB máx cada). `live-restore: true` evita derrubar containers no restart do daemon.

#### C) Limites de recursos no container do controler (anti-starvation)
No Coolify (app `a8u2gdchrpjnn6era2i8kh8d`) → *Resource Limits*: ex. **CPU 1.0–1.5**, **Mem 1–2 GB** para `api` e `web`. Assim o NOC nunca mais consegue travar o host inteiro.

#### D) App-side (código) — depois de estabilizar, na Fase 1
- Aumentar intervalos: `container-metrics`/`host-metrics` 60s → **300s** (ou desligar o `docker stats --no-stream` e usar leitura leve de cgroup/`/proc`).
- **Overlap guard:** flag `isRunning` que pula o tick se o anterior não terminou.
- **Corrigir o timeout do SSH:** envolver `execCommand` em `Promise.race` com `timeoutMs` real (mata a chamada presa).
- **Circuit breaker:** se `loadAvg[0] > N`, pula a coleta pesada.

---

## PARTE 2 — AUDITORIA FASE 0 (estática)

### 2.1 Stack e versões **reais**

**Monorepo pnpm 9** (`controler-v4` v4.0.0, Node ≥20).

**Backend — `apps/api`** (NestJS, **não** "moderno alvo"):
- NestJS 10.4 + **Fastify 4** (`@nestjs/platform-fastify`), Socket.IO 4.7
- **Prisma 5.20** + PostgreSQL 16, Redis 7 (ioredis) + **BullMQ 5**
- Auth: `@nestjs/jwt`, passport-jwt, `@nestjs/throttler`, `@fastify/rate-limit`
- Validação: **Zod 3.23** + class-validator/class-transformer (duplicado)
- Infra: `node-ssh`, `dockerode`, `@aws-sdk/client-ssm`, `axios`
- Log: `pino`/`nestjs-pino` instalados, mas **Fastify logger desligado** (`logger: false`); usa `Logger` do Nest
- Testes: **vitest** configurado (poucos/sem specs de unidade no backend)

**Frontend — `apps/web`** (já razoavelmente próximo do alvo):
- **Next.js 14.2** (App Router) + **React 18.3** + **TypeScript 5.5**
- **Tailwind 3.4** + tailwindcss-animate + cva + clsx + tailwind-merge (padrão shadcn)
- **lucide-react** (ícones — biblioteca única ✓), **framer-motion 11**, **recharts 2.12**
- Estado servidor: **SWR** (não TanStack Query), `socket.io-client`, `jose`, `sonner`, `cmdk`, `date-fns`
- Testes: **Playwright** com **10 specs E2E** + visual regression ✓

**Outros:** `packages/shared` (tipos+Zod), `packages/ui`, `mcps/hestia` (vazio/futuro).

### 2.2 Arquitetura e acoplamento

- API: 14 módulos Nest (`auth, srv1, coolify, hestia, vault, alerts, scanner, realtime, timeline, deploys, apis, analytics, users, common`).
- **Ponto de acoplamento crítico:** `common/ssh.service.ts` — quase tudo (srv1, scanner, deploys) depende de **SSH no host** para rodar comandos shell (`docker`, `systemctl`, `journalctl`, `ps`, `ss`). É o maior risco de confiabilidade e a maior fonte de carga.
- Realtime: `RealtimeGateway` (Socket.IO) + `MetricsScheduler` (`@nestjs/schedule`) acoplados a quase todos os serviços.
- Web: 1 tela de login + **8 telas** de dashboard (`overview, srv1, coolify, hestia, vault, apis, alerts, analytics`), consumindo a API via SWR + WS.

### 2.3 Inventário

- **Rotas/Controllers (13):** `auth, srv1, coolify, hestia, vault, alerts, scanner, deploys, apis, analytics, timeline, users, health`. Prefixo global `api` (exceto `health` e `/`).
- **Modelo de dados:** **15 models** Prisma (~336 linhas). Inclui métricas (`metricSnapshot`, `hostMetricSnapshot`), `timelineEvent`, `deployHistory`, auth (`otpToken`, `session`, `auditLog`, `vaultAuditLog`), sites/apis, etc.
- **Componentes UI:** `components/ui` (shadcn-like), `components/charts` (recharts), `components/layout`. 9 páginas.
- **Estado global (web):** SWR (server-state) + Socket.IO; sem Redux/Zustand.
- **Integrações externas:** SRV1 via SSH, Coolify API, Hestia, AWS SSM (segredos), Z-API/Meta (WhatsApp), Infobip (SMS), Redis/BullMQ, Hostinger (env token).
- **Segurança (já endurecida):** boot falha sem `JWT_ACCESS_SECRET` forte; helmet + CSP; CORS restrito; rate-limit global 300/min. Auditoria prévia (`auditoria-controler-2026-06-10.md`) fechou 28 achados.

### 2.4 Riscos

| Risco | Severidade | Nota |
|---|---|---|
| Acoplamento total ao SSH do host (sem timeout real) | **Alto** | estopim de carga e fragilidade; bug do `timeoutMs` |
| Polling pesado a cada 60s (`docker stats` × 41 containers) | **Alto** | amplifica o incidente |
| Sem rotação de log / sem limites de recurso no deploy | **Alto** | risco de starvation do host |
| `find` de origem desconhecida no host | **Médio/⚠️** | investigar possível comprometimento |
| Validação dupla (Zod **e** class-validator) | Médio | divergência de contrato; consolidar em Zod |
| SWR vs alvo (TanStack Query) | Baixo | migração mecânica |
| Cobertura de testes de unidade no backend baixa | Médio | E2E existe (bom para migração segura) |
| `docker.sock` montado no container da API | Médio | superfície de ataque; necessário para o produto |

### 2.5 Lacunas: atual → alvo (do seu prompt)

| Camada | Atual | Alvo | Esforço |
|---|---|---|---|
| Backend framework | NestJS 10 + Fastify 4 | **Hono** + TS | **Alto** (reescrever 14 módulos) |
| Validação | Zod + class-validator | **Zod** nas fronteiras (de `drizzle-zod`) | Médio |
| ORM/DB | Prisma 5 + Postgres | **Drizzle** + Postgres (schema = fonte da verdade) | **Alto** (migrar schema + queries) |
| Estrutura | módulos Nest | `src/modules/<recurso>/{schema,routes,service,queries,components}` | Médio |
| Frontend framework | Next 14 + React 18 | **React 19 + Vite** | **Alto** (sair do Next/App Router → SPA Vite, ou Next 15+React 19) ⚠️ |
| CSS | Tailwind 3 | **Tailwind v4** (CSS-first) | Médio |
| UI kit | shadcn-like manual | **shadcn/ui** (Tailwind v4/React 19) | Médio |
| Ícones | lucide-react ✓ | lucide-react ✓ | — |
| Server-state | SWR | **TanStack Query** | Médio |
| Client-state | — | **Zustand** (só se necessário) | Baixo |
| Animação | framer-motion 11 | **motion/react** (rename) | Baixo |
| **Visual** | tema atual | **dark-v2 + botões vivos (paleta MS Office)** | Médio |

> ⚠️ **Decisão pendente p/ React 19+Vite:** o frontend hoje é **Next.js (App Router)** com rotas server e `app/api/*`. Migrar para **Vite puro** = virar SPA e mover o `app/api` para o backend Hono. Alternativa de menor risco: **Next 15 + React 19** (mantém SSR/estrutura). Preciso da sua escolha (ver Parte 3).

---

## PARTE 3 — MAPA DE MIGRAÇÃO (plano faseado, fatias verticais)

Princípio do seu prompt: **sem big-bang**, uma fatia vertical por vez, comportamento observável idêntico, testes antes/depois, commits pequenos, **parar para revisão a cada fatia**.

### Fase 0.5 — Estabilizar o incidente (PRÉ-REQUISITO, antes de qualquer refactor)
1. Aplicar mitigações 1.5-A/B/C no host (alívio + rotação de log + limites).
2. Hotfix mínimo no app (sem migrar stack): corrigir timeout do SSH, intervalos 60s→300s, overlap guard, circuit breaker por load. — *São mudanças pequenas e reversíveis no código atual NestJS.*
3. Investigar o `find` misterioso.
4. Validar: `curl https://noc.controler.net.br/be-health` + load < 4.
**Risco:** baixo. **Rollback:** reverter `daemon.json`/limites; reativar ClamAV.

### Fatias verticais da migração (uma de cada vez, com aprovação entre elas)

> Ordem sugerida: começar pelo **frontend visual** (valor visível, baixo risco, atende o pedido do dark-v2) e por **um módulo de baixo risco** no backend antes dos críticos (auth/srv1).

1. **Fatia 1 — Design System + tema (dark-v2 + Office):** Tailwind v4 + shadcn/ui + tokens dark-v2 + botões vivos. Sem mudar dados. Valida com Playwright visual. *Risco: baixo.*
2. **Fatia 2 — Módulo `analytics` (leitura):** ponta a ponta no alvo (Drizzle read + Hono route + TanStack Query + UI). Recurso de baixo risco para validar o padrão. *Risco: baixo.*
3. **Fatia 3 — `timeline` / `deploys` (leitura).** *Risco: baixo.*
4. **Fatia 4 — `srv1`/`scanner` (host ops):** reescreve a camada SSH com timeout/circuit-breaker no alvo. *Risco: médio.*
5. **Fatia 5 — `alerts` + `realtime` (WS + filas).** *Risco: médio.*
6. **Fatia 6 — `auth` + `vault` (sensível, OTP/JWT/segredos):** por último, com mais testes. *Risco: alto.*
7. **Fatia 7 — DB:** consolidar schema Prisma→Drizzle (migrações reversíveis, revisadas por você antes de qualquer `drop`).

Cada fatia entrega: resumo, `typecheck`+`build`+testes, notas de migração reversível, pendências.

### Guardrails (do seu prompt, reafirmados)
- Sem big-bang; preservar contratos de API, auth atual, dados de produção, integrações WhatsApp/SMS/SSM.
- Migrações de dados sempre reversíveis; confirmação explícita antes de `drop`/`truncate`.
- Sem segredos em código/log. Biblioteca de ícones única (lucide).
- Em dúvida, perguntar.

---

## DECISÕES QUE PRECISO DE VOCÊ (parar aqui p/ aprovação)

1. **Incidente:** ainda estou tentando SSH. Se quiser acelerar, você pode rodar o bloco **1.5-A** + **1.5-B** direto no console/painel da Hostinger (bypassa o `actions_lock` e o sshd saturado). Confirma se aplico assim que o box voltar a aceitar SSH?
2. **Frontend:** **Next 15 + React 19** (menor risco, mantém SSR) **ou** **Vite SPA puro** (como no prompt, mas vira reescrita maior)?
3. **Ordem das fatias:** começo pela **Fatia 1 (visual dark-v2)** como sugerido, ou prefere outra?
4. **Aprovação:** posso seguir para a **Fase 0.5 (estabilização)** — que inclui hotfixes pequenos no código atual — ou paro 100% até você revisar este mapa?

**Nada de refactor da Fase 1 começa sem o seu OK.**
