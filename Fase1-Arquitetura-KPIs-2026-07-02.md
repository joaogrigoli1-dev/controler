# Fase 1 — Arquitetura do NOC + Catálogo de KPIs (controler)

> **Data:** 2026-07-02 · **Modo:** PLANEJAMENTO/DESIGN — nada de produção alterado.
> **Orquestrador:** Fable 5 · **Subagentes:** @pesquisa, @infra, @dba, @design, @validacao (todos Fable 5)
> **Base:** [Fase0-Descoberta-2026-07-02.md](./Fase0-Descoberta-2026-07-02.md) — host KVM8 (8 vCPU / 32 GB / 400 GB), kernel 6.8, 34 containers, Coolify sentinel disponível, sem stack de monitoramento, SMART/lm-sensors indisponíveis no KVM.

---

## Sumário

O NOC adota quatro frameworks canônicos, **um por camada** para evitar alerta duplicado pelo mesmo sintoma:

- **USE + PSI** (host/hardware) — Utilization, Saturation, Errors + Pressure Stall Information.
- **docker stats + cgroup pressure** (por container).
- **RED** (serviços/APIs) — Rate, Errors, Duration.
- **Golden Signals** (camada executiva /overview) — visão macro que consome os anteriores.

**Correções de fórmula assinadas por @validacao já incorporadas** neste catálogo: CPU% deixa de ser `load/N` e passa a `100 − idle` via delta de `/proc/stat` (com `%steal`); RAM usa `MemAvailable`; percentis de rollup são **recomputados do raw**, nunca agregados incrementalmente; MTTR usa 3 timestamps (`failedAt`/`detectedAt`/`resolvedAt`); todo threshold tem **duração/histerese** e guarda de volume mínimo; identidade de container por **nome/label estável** (não container id). PSI e `systemd failed` viram KPIs de primeira classe.

**Dependência crítica herdada da Fase 0:** toda a coleta de tempo real depende de SSH, e o código usa porta 22 enquanto a real é 47391 (Gap #1). A Fase 2 corrige isso **antes** de qualquer coletor novo.

---

## (a) Catálogo de KPIs

Convenção: **W** = warning (investigar, sem pager), **C** = crítico (alerta imediato Z-API→Meta / Infobip). Todo threshold exige *sustentação* (`for`) salvo indicado. RAG: teal=OK, âmbar=W, vermelho=C, cinza=STALE.

### A.1 — Host / Hardware (USE + PSI) — fonte: SSH + Hostinger API

| KPI | Fórmula / definição | Fonte | Limiar | `for` | Sev |
|---|---|---|---|---|---|
| **CPU utilização** | `100 − idle%` via delta `/proc/stat` (2 amostras); **iowait não conta como busy**; expõe user/system/iowait/steal | SSH `mpstat 1 1` ou `/proc/stat` | W>80% · C>95% | 5min | W/C |
| **CPU steal** | `%steal` do `/proc/stat` — contenção do hypervisor Hostinger | SSH | W>10% | 5min | W |
| **CPU saturação (load)** | `load1m / nproc` (nproc dinâmico=8); KPI **separado** de utilização | SSH `/proc/loadavg` | W>1.0 · C>2.0 (×nproc) | 5min | W/C |
| **PSI CPU** | `cpu some avg10/avg60` (% tempo com ≥1 task esperando CPU) | SSH `/proc/pressure/cpu` | W: some avg60>25% · C: some avg10>75% | — | W/C |
| **RAM utilização** | `(MemTotal − MemAvailable)/MemTotal` — **nunca** `free` (cache infla) | SSH `/proc/meminfo` | W>85% · C>95% | 5min | W/C |
| **PSI Memória** | `mem some/full avg10/avg60` | SSH `/proc/pressure/memory` | W: **full avg60>1–2%** · **C: full avg10>5%** | — | W/C |
| **Swap ativo** | `si/so` (páginas/s) — swap-in sustentado = pressão real | SSH `vmstat` | W: so>0 sustentado | 5min | W |
| **Disco uso** | `used/total` por mount (inclui `/var/lib/docker`) | SSH `df` + Hostinger | W>80% · C>90% | — | W/C |
| **Disco inodes** | `iused/itotal` | SSH `df -i` | W>80% · C>90% | — | W/C |
| **Disco "dias até encher"** | regressão linear sobre rollup diário de uso | derivado | W<30d · C<7d | — | W/C |
| **Disco latência** | `await` (r/w) ms | SSH `iostat -dx` | W>20ms · C>100ms | 5min | W/C |
| **Disco saturação** | `%util`, `aqu-sz` | SSH `iostat -dx` | W util>80% | 5min | W |
| **PSI IO** | `io full avg10` | SSH `/proc/pressure/io` | W>15% · C>25% | 2min | W/C |
| **Rede throughput** | RX/TX Mbps por interface (delta) | SSH `/proc/net/dev` + Hostinger | W>70% do link | 5min | W |
| **Rede erros** | drops/erros rx/tx, TCP retrans | SSH `/proc/net/dev`, `nstat` | W: retrans>1% | 5min | W |
| **OOM-kill** | evento `OOMKilled`/`dmesg oom` | SSH `dmesg`/`docker events` | **C: qualquer** (histórico do incidente 06/2026) | — | C |
| **systemd units failed** | contagem/lista `--failed` | SSH `systemctl --failed` | W≥1 · C: unit crítica (docker/ssh/staggered) | — | W/C |

### A.2 — Por container (34) — fonte: SSH (`docker stats`/`inspect` ou cgroup v2)

| KPI | Fórmula | Limiar | Sev |
|---|---|---|---|
| **CPU %** | `docker stats` CPUPerc (pode >100% multi-core) | W>80% do limite/quota · C>95% | W/C |
| **Mem %** | `MemUsage/MemLimit` (limite = host se não setado) | W>85% · C>95% | W/C |
| **Mem tendência 6h** | slope de mem sobre 6h → detecção de leak | W: crescimento monotônico 6h | W |
| **Net RX/TX** | **taxa** = Δcontador/Δt real (clamp≥0 no restart) | baseline ×3 | W |
| **Block IO r/w** | idem taxa; cgroup v2 mais confiável que docker stats | baseline ×3 | W |
| **Restart count** | Δ`RestartCount` na janela → crash-loop | W>3/24h · C: crescimento contínuo | W/C |
| **Health** | `.State.Health.Status` (healthy/unhealthy/starting/none) | C: unhealthy sustentado | C |
| **Uptime** | `now − StartedAt`; derivado de state events | informativo | — |
| **Flapping** | ≥N transições de estado na janela | W≥3 flips/1h | W |

> **Identidade estável:** registrar container por **nome/label** (Coolify recria o container id a cada deploy). O registry versiona o container id sob o nome, senão MTBF/uptime por serviço fragmentam.

### A.3 — Coolify / Deploys — fonte: Coolify API `10.0.6.1:8000`

| KPI | Fórmula | Fonte | Sev |
|---|---|---|---|
| **App status composto** | `estado:saúde` (running:healthy, exited:unhealthy…) | `coolify_list_resources` | C: exited/unhealthy |
| **Apps down** | nº apps não-running | derivado | C≥1 |
| **Deploy success rate** | `deploysOK / total` (7d/30d) | ⚠ ver nota-fonte | W<90% |
| **Deploy duração média** | média `durationSec` por app; regressão de build | `DeployHistory` | W: ×2 baseline |
| **Último deploy / resultado** | por app (commit, autor, ✓/✗) | `coolify_get_application` + history | — |

> **Nota-fonte (bloqueio):** `coolify_list_deployments` retornou **404** nos testes. Histórico de deploys precisa de rota alternativa: (a) `GET /api/v1/deployments/applications/{uuid}` direto; (b) **webhook de deploy do Coolify → módulo `deploys`** (mais robusto — registra o evento no próprio NOC no momento do deploy). Decidir na Fase 3.

### A.4 — Serviços / Sites / APIs (RED) — fonte: probes + logs de proxy

| KPI | Fórmula | Fonte | Limiar | Sev |
|---|---|---|---|---|
| **Rate (req/s)** | por serviço/domínio | logs Traefik (Coolify) | queda a 0 c/ tráfego habitual = C; desvio ×3 = W | W/C |
| **Errors %** | `5xx / total` | logs proxy | W>1%/5min · C>5%; **guarda: ≥20 req/5min** | W/C |
| **Duration p95/p99** | percentil por serviço (nunca média) | logs proxy (usuário real) **ou** probe sintético (rotular qual) | W>500ms · C>2s **por serviço** (default global) | W/C |
| **HTTP health** | código + latência TTFB | probe `curl` (do NOC ou SSH) | C: down 3× seguidas | C |
| **SSL dias p/ expirar** | `notAfter − now` por domínio (SNI) | `openssl s_client` | W≤30d · C≤7d | W/C |
| **Canais de mensagem** | Z-API principal vs Meta fallback | módulo alerts | W: fallback ativo (serviço ainda entrega) | W |

> **@validacao:** p95 **não sai de média** e exige pipeline de access logs do proxy — sem isso, metade do Golden Signal de latência é decorativa. Definir a fonte (logs Traefik do Coolify) antes de prometer o KPI. Threshold único p/ 34 serviços heterogêneos gera misfire → por serviço com default.

### A.5 — Confiabilidade / Negócio (camada /analytics)

| KPI | Fórmula corrigida | Sev |
|---|---|---|
| **Disponibilidade %** | `checksUp / (checksUp + checksDown)`; "sem dado" é **3º estado** (não conta) + reporta cobertura; exclui manutenção planejada | — |
| **MTTR** | `avg(resolvedAt − detectedAt)`; reportar também `detectedAt − failedAt` (time-to-detect ≈ intervalo de poll); incidentes abertos truncados em `now()` p/ evitar viés de sobrevivência | — |
| **MTBF** | tempo entre falhas; **não exibir com n<5 incidentes** (estatisticamente vazio); documentar que inclui tempo de reparo | — |
| **Deploy success rate** | `ok/total` (fonte a resolver, A.3) | — |
| **Health Score** | composto ponderado dos golden signals (0–100) p/ RAG do /overview | — |

> **Fix do Gap Fase 0 (uptimePercent):** hoje `analytics` espera 60 snapshots/h mas grava 12/h → reporta ~20%. Solução: **derivar uptime de eventos de transição de estado**, imune à cadência de coleta. Definir UMA cadência (raw 30s = 120/h proposto) e nunca mais amarrar KPI a contagem fixa de snapshots.

---

## (b) Arquitetura de coleta

```
                       ┌───────────────────────────── NOC (NestJS/apps/api) ─────────────────────────────┐
 Hostinger API ───30min──▶ HostingerCollector ─┐                                                          │
 (cpu/ram/disk/traf/uptime, visão hypervisor)  │                                                          │
                                               ▼                                                          │
 Coolify API 10.0.6.1:8000 ──30-60s──▶ CoolifyCollector ─┐   ┌── RollupService (@Cron) ── raw→hora→dia ──┐│
 (status apps, deploys*)                                 ├──▶│   PurgeService (@Cron 03:45) TTL           ││
                                                         │   └── AlertEngine (thresholds + for + volume)  ││
 SSH srv1:47391 ──15-30s──▶ HostCollector (PSI/iostat/   │            │ Z-API→Meta / Infobip (cooldown,    ││
 (Gap#1!)                    mem/swap/ss/systemd)         │            ▼  janela silêncio 22-7h BRT)       ││
                 ──30-60s──▶ ContainerCollector           │   Postgres 16 (séries + rollups + eventos)    ││
                             (docker stats/inspect,       │            │                                   ││
                              cgroup v2 pressure)         │            ▼                                   ││
 Proxy logs (Traefik) ─────▶ ServiceCollector (RED) ─────┘   /analytics REST + WebSocket (realtime) ──────┘│
 openssl/curl ─────────────▶ SSL/HTTP probes                                                               │
                       └──────────────────────────────────────────────────────────────────────────────────┘
```

**Papéis:** Hostinger API = baseline/backfill + steal/hypervisor (30min, não serve p/ alerta rápido). SSH = espinha dorsal do tempo real (PSI, iostat, docker) — **conexão persistente/multiplexada** com watchdog; estado "coletor cego há Xs" é alerta próprio. Coolify API = estado/deploys. Proxy logs = fonte real de p95/erros.

---

## (c) Plano de dados (Prisma / Postgres 16)

Registry normalizado + séries raw (BigInt PK) + rollups por `granularity` + eventos por transição.

```prisma
enum Granularity { hourly daily }
enum ContainerHealth { healthy unhealthy starting none exited }
enum UptimeTargetType { container site api systemd_unit host }

model Container {          // registry: 1 linha/container (34), chave = nome estável
  id Int @id @default(autoincrement())
  name String @unique
  coolifyUuid String?
  image String?  kind String @default("app")  monitored Boolean @default(true)
  currentHealth ContainerHealth @default(none)
  restartCount Int @default(0)  startedAt DateTime?
  firstSeenAt DateTime @default(now())  lastSeenAt DateTime @default(now())
  metrics ContainerMetricPoint[]  rollups ContainerMetricRollup[]  stateEvents ContainerStateEvent[]
  @@index([coolifyUuid]) @@map("containers")
}

model ContainerMetricPoint {   // raw 30s — net/blkio já como TAXA (Δ/Δt, clamp≥0)
  id BigInt @id @default(autoincrement())
  containerId Int  container Container @relation(fields:[containerId], references:[id], onDelete:Cascade)
  ts DateTime @default(now())
  cpuPercent Float  memUsedMb Float  memLimitMb Float?  memPercent Float?
  netRxKbps Float?  netTxKbps Float?  blkioReadKbps Float?  blkioWriteKbps Float?
  pids Int?  restartCount Int?  health ContainerHealth @default(none)  uptimeSec Int?
  @@index([containerId, ts(sort:Desc)]) @@index([ts]) @@map("container_metric_points")
}

model ContainerStateEvent {    // 1 linha por transição → base de uptime/timeline
  id BigInt @id @default(autoincrement())
  containerId Int  container Container @relation(fields:[containerId], references:[id], onDelete:Cascade)
  ts DateTime @default(now())  fromState String?  toState String
  exitCode Int?  oomKilled Boolean @default(false)  reason String?
  @@index([containerId, ts(sort:Desc)]) @@index([ts]) @@map("container_state_events")
}

// HostMetricSnapshot (estender, colunas nullable): swapTotalMb, swapInPagesSec, swapOutPagesSec,
//   psiCpuSomeAvg10/60/300, psiIoSome/Full Avg10/60/300, psiMemSome/Full Avg10/60/300
model HostDiskIoPoint {
  id BigInt @id @default(autoincrement())  device String  ts DateTime @default(now())
  utilPercent Float  readAwaitMs Float?  writeAwaitMs Float?
  readIops Float?  writeIops Float?  readKbps Float?  writeKbps Float?  avgQueueSize Float?
  @@index([device, ts(sort:Desc)]) @@index([ts]) @@map("host_disk_io_points")
}

model HostProcessSample {      // top-10 cpu/mem 60s — forense de leak
  id BigInt @id @default(autoincrement())  ts DateTime @default(now())  rank Int
  pid Int  command String  cgroup String?  cpuPercent Float  memMb Float
  @@index([ts(sort:Desc)]) @@map("host_process_samples")
}

model SystemdUnitEvent {       // por transição (docker/ssh/fail2ban/staggered…)
  id BigInt @id @default(autoincrement())  unitName String  ts DateTime @default(now())
  activeState String  subState String?  fromState String?  nRestarts Int?  message String?
  @@index([unitName, ts(sort:Desc)]) @@index([activeState, ts(sort:Desc)]) @@map("systemd_unit_events")
}

model SslCheckHistory {
  id BigInt @id @default(autoincrement())  domain String  checkedAt DateTime @default(now())
  ok Boolean  notAfter DateTime?  daysRemaining Int?  issuer String?  error String?
  @@index([domain, checkedAt(sort:Desc)]) @@map("ssl_check_history")
}

// DeployHistory (estender): deploymentUuid @unique (upsert idempotente), queuedAt, isRollback, imageTag, failReason
//   + @@index([coolifyUuid, startedAt(sort:Desc)])

model ContainerMetricRollup {  // p95 RECOMPUTADO do raw, nunca incremental
  id BigInt @id @default(autoincrement())
  containerId Int  container Container @relation(fields:[containerId], references:[id], onDelete:Cascade)
  granularity Granularity  bucket DateTime  sampleCount Int
  cpuAvg Float  cpuMax Float  cpuP95 Float?  memAvgMb Float  memMaxMb Float
  netRxKbpsAvg Float?  netTxKbpsAvg Float?  blkioReadKbpsAvg Float?  blkioWriteKbpsAvg Float?
  restartsDelta Int @default(0)  unhealthySec Int @default(0)
  @@unique([containerId, granularity, bucket]) @@index([granularity, bucket(sort:Desc)]) @@map("container_metric_rollups")
}

model HostMetricRollup {
  id BigInt @id @default(autoincrement())  granularity Granularity  bucket DateTime  sampleCount Int
  cpuAvg Float  cpuMax Float  loadAvg1mMax Float?  memUsedAvgMb Float  memUsedMaxMb Float  swapUsedMaxMb Int?
  psiCpuSomeMax Float?  psiIoFullMax Float?  psiMemFullMax Float?  diskUtilMaxPct Float?  diskAwaitMaxMs Float?
  @@unique([granularity, bucket]) @@map("host_metric_rollups")
}

model AvailabilityRollup {     // KPI "99.9%" por alvo — derivado de checks + state events
  id BigInt @id @default(autoincrement())  targetType UptimeTargetType  targetKey String
  granularity Granularity  bucket DateTime
  checksTotal Int @default(0)  checksUp Int @default(0)  downtimeSec Int @default(0)
  incidents Int @default(0)  uptimePct Float
  @@unique([targetType, targetKey, granularity, bucket])
  @@index([targetType, granularity, bucket(sort:Desc)]) @@map("availability_rollups")
}
```

**Retenção:** raw containers 10d · raw host 14d · raw iostat 10d · top-processos 7d · eventos de estado/systemd 180d · rollup horário 90d · rollup diário 400d (comparação YoY) · SSL 180d · deploys indefinido.

**Índices:** btree composto `(alvo, ts DESC)` p/ "últimos N de um alvo"; **BRIN em `ts`** (via SQL custom na migration — append-only, ~1000× menor) p/ purge/rollup; `@@unique(alvo, granularity, bucket)` dá o `ON CONFLICT` do job de graça; `deploymentUuid @unique`.

**Volume:** ~98k linhas/dia containers + ~3k host → **<500 MB em regime**. Postgres 16 vanilla dá conta — **sem TimescaleDB nem particionamento** nesta escala (plano B: particionar `container_metric_points` por dia se cadência cair p/ 10s ou containers passarem de ~150). Cuidar `autovacuum` pós-purge.

**Rollup (correção @validacao):** job `@Cron` **recomputa a janela fechada a partir do raw** com `ON CONFLICT DO UPDATE` (idempotente) — nunca média/p95 incremental (`(old+new)/2` é errado; p95 não é composável). Diário de p95 vem do raw (raw dura 10–14d > 1d) ou aproxima com nota. Purge em lotes de 10–50k. Catch-up ao iniciar reprocessa buckets faltantes.

**Migração:** projeto está em `db push` (sem `_prisma_migrations`). Fase 2: baseline `migrate diff --from-empty` → `migrate resolve --applied 0_init` → `migrate dev --name kpi_timeseries` (editar SQL p/ BRIN) → deploy passa a `migrate deploy`; `db push` proibido em prod.

---

## (d) Mapa de telas (dark-v2)

Hierarquia de 3 níveis, **todo número no /overview é clicável** e leva à tela que o explica. 8 telas + 2 rotas novas de drill.

```
/overview (RAG host + containers up/down + alertas + deploys)
 ├─► /srv1 (USE: CPU real/PSI/RAM/swap/disco+IOPS+await/rede/systemd/portas/top)
 │    └─► /srv1/containers/[name] (séries cpu/mem/net/blkio, restarts, health, uptime, log tail, ações OTP)  ◀ ROTA NOVA
 ├─► /coolify (apps+estados+fila deploys) └─► /coolify/[uuid] (histórico deploys, duração, envs, log)          ◀ ROTA NOVA
 ├─► /hestia (sites+SSL expiry+mail)  ├─► /apis (RED: rate/errors/duration) ├─► /analytics (disp%/MTTR/MTBF/deploy)
 ├─► /alerts (regras+histórico, link cruzado à origem)  └─► /vault (SSM, fora do fluxo NOC)
```

**Modelo mental por tela:** Golden Signals no /overview · USE no /srv1 · série por container no drill · RED no /apis · confiabilidade no /analytics.

**Telas-chave:**
- **/overview:** Health Score (RAG), Containers `n/m up`, Alertas ativos, Uptime 30d (KPIs editoriais 30px + delta 24h + sparkline). Blocos: 4 mini-cards de golden signals, **heatmap de containers** (grid clicável), deploys recentes, timeline de eventos. Coleta indisponível → card **STALE** (não zero falso).
- **/srv1:** cada recurso mostra Uso + **Saturação (PSI)** + Erro lado a lado — é a tela do incidente 06/2026. Tabela de containers = master da relação master-detail.
- **Drill container:** tela do memory-leak — mem com **linha de tendência 6h**, restarts 24h, health, log tail, ações restart/stop/start com **re-auth OTP**.
- **/apis:** barra de uptime 24 segmentos (status-page); Z-API vs Meta lado a lado (fallback ativo = âmbar, não vermelho).
- **/analytics:** disponibilidade diária com incidentes anotados; projeção "disco cheio em X dias"; MTTR/MTBF.

**Componentes (evoluindo `KpiTile`/`StatusBadge`/`Gauge`):** `KpiCard`, `RagBadge`, `Sparkline` (SVG puro p/ 40+ instâncias), `TimeSeriesChart` (Recharts, bandas de threshold + anotações de deploy/OOM), `MasterDetailTable`, `ContainerHeatmap`, `UptimeBar`, `EventTimeline`, `LogTail` (JetBrains Mono), `StaleOverlay`, `OtpActionButton`.

**Semântica de cor (fixa):** OK=teal `#2dd4bf` · Warning=âmbar `#fbbf24` (threshold W **ou** fallback ativo **ou** SSL≤30d) · Crítico=vermelho `#f87171` (threshold C, down, SSL≤7d) · Stale=cinza `#64748b` (nunca fingir verde) · Info=indigo `#a5b4fc`. Três degraus: warning silencioso (só badge/valor); crítico com borda+pulse+reordenação (sobe acima do fold); **meta-falha de coleta** (SSH/Coolify/API do NOC fora) = banner full-width. Cor nunca é canal único (sempre dot+label); no máx. 1 elemento pulsando por viewport.

---

## (e) Backlog priorizado (Fases 2–5)

| Prio | Item | Fase | Origem |
|---|---|---|---|
| **P0** | Parametrizar SSH host/porta/chave via SSM (porta 47391) — desbloqueia toda coleta | 2 | Gap #1 |
| **P0** | Hardware dinâmico: `nproc`/MemTotal/disco real; CPU% = `100−idle`+steal; `LOAD_CIRCUIT_BREAK=3×nproc` | 2 | Gap #3, @validacao |
| **P0** | Fix uptimePercent: derivar de state events, não de 60 snapshots/h | 2 | Gap #4 |
| **P0** | Baseline `prisma migrate` + proibir `db push` em prod | 2 | @dba |
| **P1** | Registry `Container` + `ContainerMetricPoint`/`StateEvent` (identidade por nome) | 3 | @dba |
| **P1** | HostCollector avançado: PSI, iostat, swap, top processos, ss, systemd (incl. 3 units failed) | 3 | @infra/@pesquisa |
| **P1** | ContainerCollector: docker stats/inspect via cgroup v2; net/blkio como taxa (clamp≥0) | 3 | @infra/@validacao |
| **P1** | AlertEngine com `for`/histerese + guarda de volume; avaliar `AlertRule` do banco | 3 | Gap #5, @validacao |
| **P1** | Coolify: resolver fonte de deploys (webhook ou `/api/v1/deployments/applications/{uuid}`); alertar exited:unhealthy | 3 | Gap #6, @infra |
| **P2** | RollupService (recompute do raw) + PurgeService (TTL, lotes) + BRIN | 3 | @dba/@validacao |
| **P2** | Pipeline de p95/erros: ingestão de access logs do Traefik/Coolify | 3 | @validacao |
| **P2** | Frontend: /overview heatmap + golden signals; /srv1 USE+PSI; drill container | 4 | @design |
| **P2** | Componentes novos (Sparkline SVG, TimeSeriesChart c/ bandas, UptimeBar, StaleOverlay) | 4 | @design |
| **P3** | /analytics: disponibilidade, MTTR (3 timestamps), MTBF (n≥5), deploy success | 4 | @design/@validacao |
| **P3** | Aplicação dark-v2 em todas as telas novas | 5 | @design |

**Top-5 riscos da arquitetura (@validacao):** (1) SSH como espinha dorsal única — corrigir Gap #1, conexão persistente + watchdog, "coletor cego" como alerta; (2) p95/erros sem fonte definida até haver ingestão de logs de proxy; (3) rollup de percentil inválido se incremental — recomputar do raw; (4) identidade de container instável entre deploys — chavear por nome/label; (5) thresholds sem duração/histerese geram tempestade de warns no boot dos 34 containers — `for:` por regra + supressão em janela de boot/deploy.

---

## Próximo passo → FASE 2

Arquitetura e catálogo aprovados por @validacao com correções incorporadas. A Fase 2 (refatoração corretiva) executa os **P0** primeiro — SSH parametrizado (47391), hardware dinâmico, fix do uptime, baseline de migrations — estabelecendo a base antes dos coletores da Fase 3.
