# Relatório Final — Controler NOC Profissional

> **Projeto:** controler v4.0.0 · **Prod:** https://noc.controler.net.br · **Infra:** SRV1 (62.72.63.18, KVM8 8vCPU/32GB/400GB)
> **Período de execução:** 2026-07-02 → 2026-07-03 · **Time:** orquestrador + subagentes Fable 5
> **Plano de referência:** `PLANO-NOC-EXECUCAO-2026-07-02.md`

---

## 1. Sumário executivo — antes / depois

**Antes (2026-07-02, manhã):** o SRV1 não tinha NENHUMA stack de monitoramento (sem Prometheus,
Grafana, cAdvisor ou Netdata). O controler existia como painel, mas modelava o hardware antigo
(4 vCPU/16 GB/200 GB vs. o KVM8 real de 8/32/400), assumia SSH na porta errada, contava ~41
containers (reais: 33), reportava uptime ~20% por bug de cadência, usava `db push` direto em
produção e carregava 3 units systemd em estado failed — incluindo o `staggered-containers`,
justamente o fix do incidente de junho.

**Depois (2026-07-03):** o controler **é o NOC**. Coleta raw de 60s do host (CPU real via
/proc/stat, PSI, iostat, rede, swap, top processos) e dos 33 containers (cpu/mem/net/blkio como
taxa, health, restarts, state events), probe SSL 6/6h de 16 domínios, captura de deploys pela API
do Coolify (43 deploys registrados na validação), rollups horário/diário recomputados do raw,
retenção com purge automático, alertas com sustentação/histerese roteados Z-API→Meta/Infobip,
10 telas dark-v2 com drill-down e contrato Zod, migrations versionadas com `migrate deploy`
automático no boot e **0 units systemd failed**. Deploy 1 validado em prod (health 200, migration
aplicada, 4 containers healthy); deploy 2 em andamento com o fix de SSH do coletor.

## 2. Fases executadas (0–6) e commits

| Fase | Entrega | Commit(s) na main |
|------|---------|-------------------|
| **0 — Descoberta** | Inventário vivo: KVM8 8/32/400, 33 containers, Coolify sentinel, sem stack de monitoramento, 3 systemd failed, SSH real 47391 | `Fase0-Descoberta-2026-07-02.md` |
| **1 — Arquitetura + KPIs** | Catálogo USE/PSI + RED + Golden Signals, plano de dados (raw→rollup→retenção), mapa de telas, backlog P0–P3 | `Fase1-Arquitetura-KPIs-2026-07-02.md` |
| **2 — Refatoração corretiva** | Hardware dinâmico (nproc/MemTotal), SSH parametrizado (porta 47391), baseline `prisma migrate`, RBAC, tokens em cookie, rate-limit Redis | (base das fases 3–5) |
| **3 — Coletores/backend** | Schedulers raw 60s, registry+séries+state events, SSL probe, deploys via API, rollups, endpoints /srv1/* e /analytics/* novos | `a76f87b` |
| **4 — Frontend NOC** | 10 rotas + login, drills de container e Coolify, contrato Zod (`apps/web/lib/schemas.ts`), mocks rotulados | `edf98e5` |
| **5 — Dark-v2 v4** | Tokens v4 (teal/indigo, Inter+JetBrains Mono), conformidade scan-dark-v2 (R7/R11/R12 = 0 violações), typecheck verde | `f07a119` |
| **6 — Deploy + hardening** | Merge na main, `migrate deploy` no CMD do Dockerfile, deploy prod, fixes systemd, fix SSH do coletor, docs | `26fe664` (Dockerfile), `50236c9` (merge), `4436d2b` (fix ssh keys) |

## 3. KPIs ativos

Convenção: **W** = warning · **C** = critical. Todos com cooldown 30min (critical fura cooldown
mas tem guarda Redis própria). Catálogo completo: `Fase1-Arquitetura-KPIs-2026-07-02.md`.

| KPI | Fonte | Cadência | Limiar W / C |
|-----|-------|----------|--------------|
| CPU host (%) | SSH /proc/stat | 60s | W >85% |
| RAM host (%) | SSH MemAvailable | 60s | W >90% |
| Disco host (%) | SSH df | 60s | W >85% |
| PSI CPU (some avg60) | SSH /proc/pressure/cpu | 60s | W >25% sustentado (≥2 ciclos) |
| PSI IO (full avg10) | SSH /proc/pressure/io | 60s | **C** >25% por 2 ciclos |
| PSI Memória (full avg10) | SSH /proc/pressure/memory | 60s | **C** >5% por 2 ciclos (risco OOM) |
| Swap thrashing (swap-out págs/s) | SSH vmstat | 60s | W >0 sustentado (≥5 ciclos) |
| Disco IO (util%, await, IOPS) | SSH iostat -dx | 60s | série p/ rollup (diskUtilMax/awaitMax) |
| Top processos (forense de leak) | SSH ps | ~5min (a cada 5 ciclos) | informativo |
| Container CPU/Mem/Net/BlkIO | SSH docker stats (33) | 60s | série + rollup p95 |
| Container unhealthy sustentado | docker inspect health | 60s | **C** 2 ciclos consecutivos |
| Container OOMKilled | docker inspect | 60s | **C** imediato na transição |
| Crash-loop | Δ restartCount | 60s | W >3 restarts/24h |
| Flapping | state events | 60s | W ≥3 transições/1h |
| Container parou | diff running set | 60s | W |
| systemd unit failed | SSH systemctl | 5min | W · **C** se docker/ssh/fail2ban |
| Deploy failed | Coolify `/api/v1/deployments/applications/{uuid}` | 5min | **C** na transição p/ failed |
| App Coolify exited/unhealthy | Coolify API | 5min | **C** (guarda 30min) |
| Sites HTTP down | probe HTTP | 15min | W (timeline) |
| SSL dias p/ expirar | TLS probe direto (16 domínios) | 6h | W ≤30d · **C** ≤7d |
| APIs de projeto (ping) | healthUrl | 30min | W |
| Disponibilidade % / MTTR / deploy success | rollups + state events | horário/diário | /analytics/reliability |
| Health Score (0–100) | composto golden signals | on-demand | /analytics/health (RAG do /overview) |

## 4. Incidentes e fixes da FASE 6

1. **SSH do coletor em prod (causa raiz do coletor cego):** o SSM `/controler/srv1/private_key_path`
   apontava para path do Mac (`~/.ssh/id_ed25519_cowork`), inexistente no container, e o sshd do
   SRV1 tem `PasswordAuthentication no` — sem chave, sem coleta. **Fix (`4436d2b` + env):** cadeia
   de chaves candidatas no SshService + env `SRV1_SSH_KEY_PATH=/root/.ssh/id_ed25519` no Coolify
   (chave montada pelo próprio Coolify). Deploy 2 em andamento com esse fix.
2. **`db push` → `migrate deploy` (`26fe664`):** baseline resolvido em prod
   (`prisma migrate resolve --applied 0_baseline`), migration `20260702195231_kpi_timeseries`
   aplicada, e o CMD do Dockerfile agora roda `prisma migrate deploy` a cada boot (idempotente).
   Backup pré-migration: `/root/backups/controler-pre-fase6-20260702-2113.sql.gz` (27 MB, `gzip -t` OK).
3. **3 units systemd failed → 0 failed:**
   - `staggered-containers.service` — script sem bit de execução → `chmod 755`;
   - `redis-server.service` — `bind 10.0.1.1` (bridge docker que sobe depois) → bind tolerante
     `-10.0.1.1` + drop-in `After=network-online.target docker.service`; ouvindo em 127.0.0.1 e 10.0.1.1;
   - `ssh-emergency.service` — `ssh.socket` ausente no Ubuntu 24 → `ExecStart=-` best-effort.
   Reversão documentada no RUNBOOK.md.

## 5. Pendências residuais

| Pendência | Detalhe |
|-----------|---------|
| Validação visual em navegador | Conferir telas em 1280 e 1920 (charts do drill, heatmap /analytics, glow do login, CardError) — sem browser no ambiente de execução |
| MTBF | Só será exibido com **n≥5 incidentes** (estatisticamente vazio antes disso) — aguardando acúmulo |
| p95 real de latência | Aguarda ingestão de access logs do Traefik; a latência atual é **probe sintético rotulado** na UI |
| Migration em dev local | Rodar `pnpm --filter @controler/api prisma:migrate` quando o Docker local estiver up |
| Deploy 2 | Confirmar coletor gravando pós-deploy (fix SSH) — ver checklist no RUNBOOK §Coletores |

## 6. Operação — onde ver cada coisa

- **Saúde geral / "single most important thing":** https://noc.controler.net.br/overview (Health Score RAG + golden signals)
- **Host (USE+PSI, IO, rede, processos, portas, systemd):** /srv1
- **Containers (grade 33 + drill com séries/eventos/ações OTP):** /srv1/containers → /srv1/containers/[name]
- **Deploys e apps Coolify (+drill):** /coolify → /coolify/[uuid]
- **Sites, SSL expiry, mail stack:** /hestia · **APIs externas (RED):** /apis
- **Disponibilidade %, MTTR, deploy success, tendências:** /analytics
- **Alertas (regras, histórico, teste):** /alerts · **Segredos SSM (reveal com OTP):** /vault
- **Health da API:** `curl https://noc.controler.net.br/be-health` (health do Coolify desabilitado — validação manual)
- **Verificar coletores / migrations / rollback / systemd:** RUNBOOK.md (seções novas da FASE 6)
- **Alertas push:** WhatsApp Z-API (fallback Meta) e SMS Infobip; digest diário 08:00 BRT

---

*Gerado na FASE 6 (documentação final) em 2026-07-02/03 por @backend/@validacao (Fable 5).*
