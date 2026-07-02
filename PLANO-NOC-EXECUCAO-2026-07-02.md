# Plano Mestre de Execução — Controler NOC Profissional

> **Projeto:** controler v4.0.0 · **Infra:** SRV1 (62.72.63.18) · **Prod:** https://noc.controler.net.br
> **Data:** 2026-07-02 · **Modo:** autonomia total, execução faseada com auto-avanço
> **Orquestração:** cada fase é **um prompt único**, executado por um **orquestrador Fable 5** que coordena um **time de subagentes Fable 5**.

---

## Como usar este documento

Cada seção `FASE N` abaixo contém **um único prompt** pronto para copiar e colar. Você executa uma fase por vez; ao final de cada uma, o orquestrador **avança automaticamente** para a próxima. Todos os prompts assumem **autonomia total para implementar** (refatorar, criar recursos, redesenhar e fazer deploy), sempre com validação (`tsc --noEmit` em `apps/api` e `apps/web` + health check pós-deploy `curl https://noc.controler.net.br/be-health`).

### Time de subagentes (todos em Fable 5)

| Papel | Responsabilidade | MCPs / ferramentas |
|---|---|---|
| **@orquestrador** | Planeja, distribui, consolida, aplica gates de qualidade, avança de fase | Task, TaskCreate/Update |
| **@infra** | SRV1 (SSH), Coolify, Hostinger, AWS SSM, Cloudflare | `ssh_*`, `coolify_*`, `hostinger_*`, `aws ssm`, `cloudflare_*` |
| **@dba** | Prisma schema, migrations, índices, integridade | `database` (leitura), Prisma CLI |
| **@backend** | NestJS: módulos, coletores, endpoints, alertas, scheduler | Read/Edit/Write, Bash |
| **@frontend** | Next.js: telas, KPIs, gráficos, realtime | Read/Edit/Write, Bash |
| **@design** | Padrão visual `/dark-v2` + conformidade `/scan-dark-v2` | Skills dark-v2, scan-dark-v2 |
| **@pesquisa** | Benchmarks de NOC profissional, golden signals, USE/RED | WebSearch, web_fetch |
| **@validacao** | Typecheck, health, QA, verificação factual | Bash, Agent (verificação) |

> **Regra de modelo:** o orquestrador e **todos** os subagentes usam o modelo **Fable 5** (`model: "fable"` na tool `Agent`). Lançar subagentes independentes **em paralelo** sempre que não houver dependência.

### Gates de qualidade (aplicados ao fim de TODA fase)

1. `pnpm --filter @controler/api exec tsc --noEmit` **e** `pnpm --filter @controler/web exec tsc --noEmit` → zero erros.
2. Sem segredos hardcoded; segredos sempre via SSM (`/controler/*`, `/shared/*`).
3. Convenções João: WhatsApp = Z-API→Meta (fallback); SMS = Infobip.
4. Se houver deploy: health check manual obrigatório (`/be-health`) — health check do Coolify está desabilitado.
5. `@validacao` assina cada fase antes do auto-avanço.

---

## Contexto vivo (Fase 0 já executada em 2026-07-02)

**Fatos descobertos ao vivo — use como verdade de partida:**

- **Hardware REAL do SRV1:** Hostinger **KVM 8 — 8 vCPU / 32 GB RAM / 400 GB disco**, Ubuntu 24.04.4 LTS, kernel 6.8. **O código atual modela o hardware ANTIGO (4 vCPU / 16 GB / 200 GB).** Corrigir: fallback de memória (16 GB), aproximação de CPU `load/4`, e `LOAD_CIRCUIT_BREAK = 12` (deveria escalar para 8 núcleos).
- **SSH do SRV1:** host `62.72.63.18`, **porta `47391`** (não 22), usuário `root`, chave `~/.ssh/id_ed25519_cowork`. Perfil salvo no cofre: `srv1`. **O código usa porta 22 + `/root/.ssh/id_ed25519`** → divergência a corrigir.
- **Containers:** **33 containers rodando** (não ~41). Stacks: Coolify (db/proxy/redis/realtime/sentinel/coolify), controler (api/web/postgres/redis), myclinicsoft, **xospam** (api/web/admin/postgres/redis/**ollama**), mail (mailserver/roundcube/mariadb-sites), nextcloud, postgres-main, libertakidz, fisiomt, t4net(+db), passaro, apptecph, manalista.
- **Coolify:** 13 recursos, 9 projetos, 1 servidor (`localhost` / `j4ws844wcg400kwsc0sswocg`). Estados atuais: 4 `exited:unhealthy` (passaro-professor, libertakidz-backend, manalista, apptecph-web), 1 `degraded`. **Coolify roda `coolify-sentinel` (agente de métricas) — nova fonte de dados a integrar.**
- **Sem stack de monitoramento** (nenhum Prometheus/Grafana/cAdvisor/Netdata) → o **controler é o NOC**; construção greenfield.
- **Hardware físico (SMART/temperatura) NÃO é exposto** em VPS KVM → o monitoramento de "hardware" deve usar métricas do **provedor (Hostinger API)** + OS convidado (loadavg, IO `iostat`, memória, swap, pressão PSI) — não SMART/lm-sensors.
- **Serviços systemd falhados:** `redis-server.service`, `ssh-emergency.service`, `staggered-containers.service` (o fix anti-thundering-herd do incidente de junho **está failed** — investigar).
- **Saúde atual:** CPU ~7 %, RAM ~7 GB/32 GB (~23 %), disco 68 GB/387 GB (~18 %), load 0.64, uptime ~9 dias — estável.

---

## FASE 0 — Descoberta & Inventário (✅ concluída · prompt de reprodução/atualização)

```
Você é o @orquestrador (Fable 5) de uma auditoria de descoberta SOMENTE-LEITURA da infraestrutura do projeto controler. Objetivo: conhecer o SRV1, TODOS os containers e todo o Coolify, e comparar com o que o código controler assume hoje.

Lance em paralelo, todos com model:"fable":
- @infra: via MCP, colete (a) Hostinger vps_get + vps_metrics (vm_id 1379597); (b) coolify_list_resources, list_servers, list_projects, get_server_resources; (c) SSH no perfil "srv1" (host 62.72.63.18, porta 47391) e rode: nproc, free -h, df -h /, cat /proc/loadavg, uname -r, docker ps -a --format, docker stats --no-stream, systemctl --state=failed, iostat -dx, ss -tlnp; (d) aws ssm_list em /controler e /shared (NÃO revele valores SecureString).
- @backend: extraia do código (apps/api/src) todas as suposições de hardware, portas, contagem de containers e fontes de métrica.
- @validacao: cruze descoberta viva × código e liste divergências.

Entregue um relatório markdown "Fase0-Descoberta-<data>.md" com: inventário de hardware, tabela dos 33 containers (nome, imagem, status, stack), mapa Coolify (projetos/recursos/estados), fontes de métrica disponíveis (Hostinger API, Coolify sentinel, SSH/OS, docker stats), lacunas código×realidade, e uma matriz "gap → impacto → correção proposta". NÃO altere nada. Ao concluir, avance para a FASE 1.
```

---

## FASE 1 — Pesquisa & Arquitetura do NOC + Catálogo de KPIs

```
Você é o @orquestrador (Fable 5). Objetivo desta fase: definir a ARQUITETURA de um NOC profissional para o SRV1 + containers + Coolify, e o CATÁLOGO DE KPIs, com base em benchmark de mercado. Nada de produção é alterado nesta fase — é planejamento e design.

Contexto de partida: use o relatório da Fase 0 (hardware 8c/32GB/400GB, 33 containers, Coolify sentinel disponível, sem stack de monitoramento, SMART/temperatura indisponíveis em VPS).

Lance em paralelo (model:"fable"):
- @pesquisa: pesquise (WebSearch/web_fetch) e sintetize práticas de NOC profissional: Google SRE "Four Golden Signals" (latência, tráfego, erros, saturação), método USE (Utilization/Saturation/Errors) para hardware, método RED (Rate/Errors/Duration) para serviços, métricas de saturação Linux via PSI (/proc/pressure), boas práticas de retenção/agregação de séries temporais, e padrões de dashboards NOC (visão macro → drill-down). Cite fontes.
- @infra: liste EXATAMENTE quais sinais são coletáveis por fonte: (1) Hostinger API (cpu/ram/disk/tráfego/uptime), (2) Coolify sentinel/API (estado de apps, deploys), (3) SSH/OS (loadavg, PSI cpu/io/memory, iostat, ss, systemd), (4) docker stats por container (cpu/mem/net/blkio), (5) health HTTP de sites e APIs, (6) SSL expiry.
- @dba: proponha a extensão do modelo de dados (novas tabelas/colunas Prisma) para suportar os novos KPIs e histórico por container/serviço, com política de retenção e agregação (raw → rollup horário/diário) e índices.
- @design: rascunhe a informação-arquitetura das telas NOC (o que cada painel mostra, hierarquia macro→drill-down) alinhada ao /dark-v2.

Entregue "Fase1-Arquitetura-KPIs-<data>.md": (a) catálogo de KPIs (nome, fórmula, fonte, limiar de alerta, severidade) cobrindo host, por-container, Coolify/deploys, rede, disco/IO, saturação PSI, sites/SSL, APIs; (b) diagrama da arquitetura de coleta; (c) plano de dados (tabelas + retenção + rollups); (d) mapa de telas; (e) backlog priorizado para as Fases 2-5. @validacao revisa fórmulas e viabilidade. Ao concluir, avance para a FASE 2.
```

---

## FASE 2 — Refatoração Corretiva (realidade + achados de auditoria)

```
Você é o @orquestrador (Fable 5). Objetivo: corrigir o código para a realidade do SRV1 e sanar os achados da auditoria técnica, estabelecendo uma base sólida antes de novos recursos. AUTONOMIA TOTAL para implementar. Trabalhe em branch, valide com typecheck.

Corrija (com @backend, @dba, @infra, model:"fable"):
1. HARDWARE: remova as suposições de 4 vCPU/16 GB/200 GB. Use detecção dinâmica (nproc, MemTotal, disco real) e ajuste a aproximação de CPU e o LOAD_CIRCUIT_BREAK para escalar com o nº de núcleos (ex.: 3× nproc). Fonte: apps/api/src/srv1/srv1.service.ts e realtime/metrics.scheduler.ts.
2. SSH: parametrize host/porta/chave via env+SSM (porta real 47391, chave id_ed25519_cowork). Fonte: apps/api/src/common/ssh.service.ts.
3. MIGRATIONS: adote `prisma migrate` com baseline do estado atual; crie a pasta migrations/ versionada; documente que `db push` é proibido em produção.
4. RBAC (achado A-01): crie RolesGuard + @Roles('admin') e aplique nas rotas destrutivas (vault reveal, srv1 restart/action, coolify deploy/stop/start, scanner fix).
5. TOKENS (achado A-02): mova o refresh para cookie httpOnly+Secure+SameSite; access em memória no frontend; endureça a CSP.
6. RATE-LIMIT (achado M-02): unifique no Redis (remova o Map em memória do AuthService); expurgo/TTL.
7. Correções menores: proteger /auth/diagnostic (M-03) e remover payload raw; disparar alerta de login concorrente (M-05); validar uuid no CoolifyService (B-06); higiene de repo (M-06: remover RH/backup do versionamento); corrigir classe de cor dinâmica da timeline (B-01); cache no vault listByProject (B-03).

Gate: `tsc --noEmit` (api+web) verde; testes existentes passam. @validacao assina. NÃO faça deploy ainda (deploy é a Fase 6). Ao concluir, avance para a FASE 3.
```

---

## FASE 3 — Coletores & Backend de Monitoramento + Novos KPIs

```
Você é o @orquestrador (Fable 5). Objetivo: implementar os novos recursos de monitoramento do SRV1, dos 33 containers e do Coolify, materializando o catálogo de KPIs da Fase 1. AUTONOMIA TOTAL. Branch + typecheck.

Implemente (com @backend, @dba, @infra, model:"fable"):
1. COLETOR DE HOST AVANÇADO: além de cpu/mem/disk, colete saturação via PSI (/proc/pressure/{cpu,io,memory}), iostat (util%, await, IOPS, throughput), swap, pressão de memória, top processos, portas em escuta. Persista em tabelas novas (Fase 1).
2. COLETOR POR CONTAINER: histórico por container (cpu/mem/net/blkio via docker stats), estado/health, contagem de restarts, uptime; detecção de flapping. Escale para 33 containers com o circuit-breaker corrigido.
3. INTEGRAÇÃO COOLIFY: consuma coolify sentinel/API para estado de apps, e registre deploys (já há polling — enriqueça com duração, sucesso/falha, autor, commit). Detecte apps exited:unhealthy e alerte.
4. SAÚDE DE SERVIÇOS: systemd failed (incluindo os 3 já falhados), sites HTTP + SSL expiry, APIs de projeto.
5. NOVOS KPIs: implemente os do catálogo (golden signals, USE/RED, disponibilidade %, MTTR/MTBF, taxa de sucesso de deploy, saturação PSI, IOPS/latência de disco, throughput de rede, restarts de container, cobertura de SSL). Exponha em endpoints /analytics e via WebSocket.
6. ALERTAS: novas regras + limiares (do catálogo), respeitando cooldown e janela de silêncio; roteamento Z-API→Meta / Infobip conforme convenção.
7. ROLLUPS/RETENção: job de agregação raw→horário→diário + limpeza conforme política da Fase 1.

Gate: `tsc --noEmit` verde; migrations aplicadas em dev; @validacao valida os KPIs contra dados reais (amostra via MCP). Ao concluir, avance para a FASE 4.
```

---

## FASE 4 — Frontend NOC (telas, KPIs, gráficos, drill-down)

```
Você é o @orquestrador (Fable 5). Objetivo: entregar a experiência NOC no frontend consumindo os novos KPIs/coletores. AUTONOMIA TOTAL. Branch + typecheck.

Implemente (com @frontend, @design, model:"fable"):
1. VISÃO MACRO (/overview): painel de saúde global (host, containers, Coolify, sites, APIs) com golden signals e semáforos; "single most important thing".
2. SRV1 (/srv1): saturação PSI, IO/disco (IOPS, await), rede, swap, top processos, portas — com histórico e limiares.
3. CONTAINERS (nova tela ou aba): grade dos 33 containers com cpu/mem/net/restarts/health, drill-down por container com séries temporais.
4. COOLIFY (/coolify): estado de apps/deploys, taxa de sucesso, apps unhealthy destacados, ação de restart/deploy (com re-auth OTP e RBAC).
5. ANALYTICS (/analytics): novos KPIs (MTTR/MTBF, disponibilidade, sucesso de deploy, tendências, heatmaps).
6. UX: loading/skeleton states, error boundary, timeouts no fetch, validação Zod nas respostas (achado B-04).

Gate: `tsc --noEmit` (web) verde; todas as telas renderizam com dados reais/mocks; @validacao revisa. Ao concluir, avance para a FASE 5.
```

---

## FASE 5 — Redesign Visual `/dark-v2` + Conformidade `/scan-dark-v2`

```
Você é o @orquestrador (Fable 5) com @design liderando (model:"fable"). Objetivo: aplicar o padrão visual premium ao NOC inteiro e garantir conformidade.

1. Rode a skill /dark-v2 para carregar o padrão visual vigente (v4 "Premium"): fundo atmosférico, cards em gradiente com borda dupla e sombra profunda, accent teal + indigo, tipografia Inter + JetBrains Mono, KPIs editoriais com delta + sparkline, glass disciplinado. IMPORTANTE: adapte o alvo para apps/web (App Router / app/(dashboard)) do controler — a skill foi escrita para client/src/pages do MyClinicSoft; aplique os mesmos TOKENS e componentes compartilhados, NUNCA tela a tela.
2. Implemente o tema no nível mais alto da cadeia de herança (tokens/CSS/componentes compartilhados de apps/web), propagando para todas as telas do NOC.
3. Rode /scan-dark-v2 para varrer todas as páginas e reportar violações por tela e por regra (cards, estados Error/Empty/Data, diálogos nativos → AlertDialog, contraste WCAG AA). Corrija SOMENTE no nível de token/componente compartilhado.
4. Gere um relatório de conformidade antes/depois.

Gate: `tsc --noEmit` (web) verde; scan-dark-v2 sem violações críticas; screenshots das telas principais para verificação visual (@validacao). Ao concluir, avance para a FASE 6.
```

---

## FASE 6 — Validação, Deploy e Hardening

```
Você é o @orquestrador (Fable 5). Objetivo: validar tudo, fazer deploy em produção e endurecer. AUTONOMIA TOTAL, mas com validação rigorosa (produção real).

1. VALIDAÇÃO FINAL (@validacao, subagente dedicado): `tsc --noEmit` api+web; rodar testes; revisar migrations; conferir que segredos vêm do SSM; checklist de segurança (RBAC aplicado, tokens em cookie, rate-limit Redis, diagnostic protegido).
2. MIGRATIONS EM PROD: aplicar `prisma migrate deploy` (nunca db push). Backup/valide antes.
3. DEPLOY: via Coolify (UUID a8u2gdchrpjnn6era2i8kh8d) — `coolify_deploy`. Acompanhar logs.
4. HEALTH PÓS-DEPLOY (obrigatório, health do Coolify está OFF): `curl https://noc.controler.net.br/be-health` e validar telas.
5. HARDENING/OPS: investigar e corrigir os 3 serviços systemd failed (redis-server, ssh-emergency, staggered-containers); confirmar que os coletores estão populando as tabelas; validar alertas com um disparo de teste.
6. DOCS: atualizar ARCHITECTURE.md, RUNBOOK.md, SRV1_INVENTORY.md (33 containers, hardware 8c/32GB) e CLAUDE.md (porta SSH, hardware).

Gate final: /be-health OK, telas OK, coletores gravando, alerta de teste entregue. Entregue "Relatorio-Final-NOC-<data>.md" com o antes/depois e KPIs ativos. FIM.
```

---

## Ordem de dependência (resumo)

```
FASE 0 (descoberta) ──▶ FASE 1 (arquitetura+KPIs) ──▶ FASE 2 (refatoração base)
       └──────────────────────────────────────────────────────┘
FASE 2 ──▶ FASE 3 (coletores/backend) ──▶ FASE 4 (frontend) ──▶ FASE 5 (dark-v2) ──▶ FASE 6 (deploy)
```

**Princípios inegociáveis:** segredos só via SSM; convenção de canais (Z-API→Meta / Infobip); typecheck verde por fase; health manual pós-deploy; subagentes e orquestrador sempre em **Fable 5**; validação assina cada fase antes do auto-avanço.
