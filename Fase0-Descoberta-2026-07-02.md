# Fase 0 — Descoberta & Inventário da Infraestrutura SRV1 (controler)

> **Data:** 2026-07-02 · **Modo:** SOMENTE-LEITURA — nada foi alterado, criado, reiniciado ou parado em produção.
> **Orquestrador:** Fable 5 · **Subagentes:** @infra, @backend, @validacao (todos Fable 5)
> **Fontes:** Hostinger API · Coolify API · SSH SRV1 (perfil `srv1`) · AWS SSM
> **Alvo:** SRV1 (Hostinger KVM8, 62.72.63.18) · Coolify app UUID `a8u2gdchrpjnn6era2i8kh8d` · Prod https://noc.controler.net.br

---

## Sumário executivo

Servidor **folgado e saudável** agora (CPU ~7%, RAM 7/32 GB, disco 18%, load ~1 em 8 cores) — contraste total com o incidente de 15/06 (load ~178 no KVM4 antigo). A descoberta revelou **duas fragilidades críticas** e um conjunto de divergências código × realidade:

1. **A mitigação do incidente de junho está morta.** `staggered-containers.service` (anti thundering-herd de boot) está `failed`, e o NOC não percebe porque só monitora uma whitelist fixa de units. Próximo reboot pode reabrir o incidente.
2. **A telemetria SSH inteira está pendurada na porta 22**, que o hardening pendente deveria fechar. O sshd escuta em `22` **e** `47391`; o código usa a 22 (default hardcoded) e ignora `/shared/srv1/port` (que já existe no SSM). Fechar a 22 mata silenciosamente containers, systemd e métricas de host via SSH.

**Achado estrutural:** o servidor foi **escalado de KVM4 (4c/16GB/200GB) para KVM8 (8c/32GB/400GB)**. Todo o código que pressupõe o hardware antigo ficou defasado — fallback de 16 GB, CPU `load/4`, breaker=12. Além disso: `uptimePercent` reporta ~20% com host 100% saudável; `AlertRules` do banco nunca são avaliadas; 4 apps Coolify estão `exited` há semanas sem alerta.

---

## 1) Inventário de hardware (Hostinger — vm_id 1379597 + OS ao vivo)

| Item | Realidade (2026-07-02) | O que o código assume | Divergência |
|---|---|---|---|
| Plano | **KVM 8** | — | — |
| vCPU | **8** (`nproc`=8) | 4 (`load/4`, breaker=12) | **SIM** |
| RAM | **32 GB** (31 GiB) | 16 GB (fallback hardcoded) | **SIM** |
| Disco | **400 GB** (`/dev/sda1` 387 G · 68 G · 18%) | 200 GB (fallback) | **SIM** |
| SO / Kernel | Ubuntu 24.04 LTS · **6.8.0-124-generic** | — | — |
| Bandwidth | 32 TB | — | — |
| IPv4 / IPv6 | 62.72.63.18 (PTR null) · 2a02:4780:14:44ba::1 | 62.72.63.18 | — |
| Criada / DC | 2026-02-15 · data center id 14 | — | — |
| **Uptime** | ~9,2 dias (795.262 s) | — | consistente c/ reboot pós-incidente |

**Saúde ao vivo (última 1h):** CPU ~7,2–7,3% · RAM ~7,53 GB (23%) · disco ~72 GB (18%) · load `0.93 0.96 1.02` · swap 4 GB (2,5 MB usado). iostat `sda` %util ~8% média (~0 instantâneo) — **sem saturação**.

---

## 2) Acesso SSH (AWS SSM `/shared/srv1/*`)

| Parâmetro | Valor real | Código controler | Divergência |
|---|---|---|---|
| host | 62.72.63.18 | 62.72.63.18 | — |
| **porta** | **47391** (sshd escuta 22 **e** 47391) | 22 (default hardcoded) | **SIM** |
| usuário | root | root | — |
| chave | via SSM `srv1/private_key_path` | `/root/.ssh/id_ed25519` | **SIM** |

> **Reconciliação (por que a coleta funciona hoje):** `ssh.service.ts:23` usa porta 22 default; `srv1()` (`:115-117`) nunca passa porta; `SRV1_SSH_PORT` não existe no repo; `/shared/srv1/port` no SSM **não é consumido**. Não há contradição — o sshd ainda escuta na 22, e a coleta se apoia nela. O código está *acidentalmente funcional*. Quando o reharden fechar a 22, toda a coleta SSH morre em silêncio. **Ver Gap #1.**

---

## 3) Tabela de todos os containers (docker ps -a — 34 containers, **todos "Up", nenhum exited**)

| Container | Imagem | Status | Portas |
|---|---|---|---|
| **api-a8u2gdchrpjnn6era2i8kh8d** (controler API) | build 207a93f | Up 5d (healthy) | 4000 |
| **web-a8u2gdchrpjnn6era2i8kh8d** (controler web) | build 207a93f | Up 5d (healthy) | 3000 |
| postgres-a8u2gdchrpjnn6era2i8kh8d | 667495ca2ac3 | Up 5d (healthy) | 5432 |
| redis-a8u2gdchrpjnn6era2i8kh8d | redis:7-alpine | Up 5d (healthy) | 6379 |
| coolify | coolify:latest | Up 6d (healthy) | 8000→8080 |
| coolify-sentinel | sentinel:0.0.21 | Up 9d (healthy) | — |
| coolify-realtime | coolify-realtime:1.0.16 | Up 9d (healthy) | 6001-6002 |
| coolify-db | postgres:15-alpine | Up 9d (healthy) | 5432 |
| coolify-redis | redis:7-alpine | Up 9d (healthy) | 6379 |
| coolify-proxy | traefik:v3.6 | Up 9d (healthy) | 80, 443 (tcp/udp), 8080 |
| myclinicsoft (jckc0cc…) | build fcdc846 | Up 26h (healthy) | 5000 |
| app-t4net (g9gh1js8…) | build 0fea255 | Up 5d (healthy) | 5000 |
| t4net-db (lwl11kqe…) | postgres:16-alpine | Up 5d (healthy) | 5432 |
| apptecph-robots (iwao0v8v…) | :latest | Up 5d | 80 |
| apptecph-home (dq0d8m0k…) | nginx:alpine | Up 5d | 80 |
| passaro-web (b6xzism…) | passaro-php72-ioncube | Up 5d | 80 |
| clinicafisiomt-web | nginx:alpine | Up 5d | 80 |
| gc4088ks… | build 69b864c | Up 5d (healthy) | 80 |
| roundcube | roundcubemail:1.7.1-apache | Up 5d | 80 |
| mailserver | docker-mailserver:latest | Up 5d | 25, 143, 465, 587, 993 (públicos) |
| nextcloud (dzsg3ewo…) | nextcloud:stable-apache | Up 5d | 80 |
| mariadb-sites | mariadb:10.11 | Up 5d | 3306 |
| libertakidz-postgres | 667495ca2ac3 | Up 5d | 5432 |
| myclinicsoft-redis / nextcloud-redis / libertakidz-redis | aa189b5a1954 | Up 5d | 6379 |
| xospam_api | local | Up 5d (healthy) | 8000 |
| xospam_web | local | Up 5d | 3000 |
| xospam_admin | local | Up 5d | 3001 |
| xospam_postgres | postgres:17 | Up 5d (healthy) | 5432 |
| xospam_redis | valkey:8 | Up 5d (healthy) | 6379 |
| xospam_ollama | ollama | Up 5d | 11434 (**limite mem 6 GiB** — mitigação leak) |
| postgres-main | postgres:16 | Up 5d (healthy) | 127.0.0.1:5433→5432 |

**Processos do HOST (não-container) escutando:** postgres do host em `127.0.0.1:5432` (pid 1013) e **ollama do host em `*:11434`** — revisar exposição no firewall na reharden pendente.

**Top memória (docker stats):** mailserver 1,17 GiB (3,7%) · xospam_api 379 MiB · coolify 309 MiB · nextcloud 262 MiB · mariadb 240 MiB · myclinicsoft 232 MiB. CPU tudo <5%. **Nenhum leak aparente agora.**

> **Nota de contagem:** docs/comentário citam **41 containers** e o run anterior contou **33**; a contagem viva atual é **34** (incluindo `postgres-main`). O número não deve ser afirmado estaticamente — usar contagem dinâmica e atualizar `SRV1_INVENTORY.md`.

---

## 4) Mapa Coolify (projetos / recursos / estados)

**Server:** localhost · UUID `j4ws844wcg400kwsc0sswocg` · host.docker.internal:22 · sem Swarm.
**Projetos (9):** My first project, MyClinicSoft, Infraestrutura, LibertaKidz, FisioMT, MAnalista, Sites Migrados srv2, AppTecPH, T4Net.

| Recurso | Tipo | Status | UUID | Domínio |
|---|---|---|---|---|
| **controler** | app | running:healthy | a8u2gdchrpjnn6era2i8kh8d | ⚠ fqdn no Coolify = `*.sslip.io` (não noc.controler.net.br) |
| myclinicsoft | app | running:healthy | jckc0ccwssowwc0oocw80ogs | myclinicsoft.com.br |
| app-t4net | app | running:healthy | g9gh1js85uwh6s1r6vqlcrid | app.t4net.com.br |
| t4net-db | postgres | running:healthy | lwl11kqecw4y9ixouqpuem3q | — |
| apptecph-robots | app | running:unknown | iwao0v8vi5p8r8buqr2bwopc | apptecph.com.br / www |
| apptecph-home | app | running:unknown | dq0d8m0k5tz54bz3tfd7f1g8 | (sem domínio) |
| nextcloud | service | running:unknown | dzsg3ewo0nrkycgzt1ba6xa2 | — |
| fisiomt-web | service | running:unknown | b12yx8w9gakophi1dvnaddmx | — |
| passaroprofessor | service | degraded:unhealthy | b6xzismhgizwn5nz6ry6evl8 | — (container passaro-web está Up) |
| **passaro-professor** | app | **exited:unhealthy** | v8so4ocgkkkk8ows48skggcg | passaroprofessor.com.br (offline desde 06-15) |
| **manalista** | app | **exited:unhealthy** | x4g4sgw48s4s84wg8kkggs8g | manalista.com.br (offline desde 06-18) |
| **apptecph-web** | app | **exited:unhealthy** | m56hx08nsdc65kxvtadczbfv | war.apptecph.com.br (offline desde 06-15) |
| **libertakidz-backend** | app | **exited:unhealthy** | yow040wosgowks8o80gk88g4 | libertakidz.com.br / app. (offline desde 05-28) |

> **Discrepância:** Coolify marca 4 apps `exited:unhealthy`, mas o `docker ps -a` não tem containers exited — esses apps **não têm container** (parados/removidos e nunca resubidos há semanas). Ver Gap #6.
>
> **Reconciliar:** a tabela `projects` do controler é semeada com 9 projetos que não correspondem 1:1 aos 9 reais do Coolify (modelo órfão) — reforça achado de seed desalinhado.
> **`coolify-sentinel`** (0.0.21) roda no host → fonte de métricas/estado sub-explorada, a integrar no NOC além do polling atual.

---

## 5) Fontes de métrica disponíveis (para o NOC)

| Módulo / Fonte | Sinais | Detalhe |
|---|---|---|
| **srv1** — Hostinger API **+** SSH (fallback mútuo) | cpu, ram, disk, tráfego, uptime · load, mem, disk, containers | host: `getMetrics()` ∥ SSH (`/proc/loadavg`,`free -b`,`df -B1 /`,`/proc/uptime`); containers via `docker ps -a`+`docker stats`; systemd via `systemctl show`; portas via `ss -tlnp`; cache Redis 10–60s |
| **coolify** — REST API `/api/v1` | estado de apps, deploys | token SSM `/controler/coolify_token` |
| **hestia** — HTTP direto + SSH | status de sites, SSL | `axios.get(https://{domain}/)`, `openssl s_client`, filtro docker `mail\|roundcube\|nextcloud\|stalwart` |
| **scanner** — SSH docker/systemctl | exited, dangling, `system df`, `--failed` | prune whitelisted |
| **analytics** — só Postgres (Prisma) | agregações | consome snapshots persistidos pelo scheduler |
| **alerts** — despacha (não coleta) | — | Z-API → Meta Graph v18 → Infobip SMS; cooldown 30min; silêncio 22h-7h BRT |
| **apis** — HTTP ping | health de ProjectApi | GET no `healthUrl` (<400 healthy) |
| **realtime/scheduler** — orquestra | — | host+containers 5min (12/h), sites 15min, apis 30min, coolify 5min |

> **Hardware físico (SMART/temperatura) NÃO é exposto** neste VPS KVM (`smartctl`/`sensors` indisponíveis). O "monitoramento de hardware" deve se apoiar em **Hostinger API + métricas do OS convidado** (PSI `/proc/pressure`, IO/await, memória, swap) — não em SMART/lm-sensors.

**SSM keys disponíveis** (só nomes — valores SecureString não revelados):
- **/controler (6):** auth_pass, auth_user, coolify_token, fisiomt_hestia_password, fisiomt_ssh_password, srv2_ssh_password
- **/shared (14):** alert_phone, infobip/{api_key,base_url}, mariadb-sites/{nextcloud,passaro,root}_password, **srv1/{host, port=47391, username, password, root_password, private_key_path}**, zapi/{instance_id, token}
- **Identidade AWS ativa:** `arn:aws:iam::178701498845:user/myclinicsoft-rekognition`

> `/shared/srv1/port` **existe no SSM mas nunca é lido pelo código** — ver Gap #1.

---

## 6) Serviços systemd falhados (ao vivo)

- `redis-server.service` — **failed** (Redis do host; todos os Redis reais rodam em container → provável unit órfã do apt).
- `ssh-emergency.service` — **failed** (unit de recuperação de SSH).
- `staggered-containers.service` — **failed** — *"Staggered start of non-critical containers (anti CPU thundering-herd)"*: **é o fix do incidente de junho, e está falhado.** Ver Gap #2.

---

## 7) Matriz de divergências: Gap → Impacto → Severidade → Correção

| # | Gap | Real vs Código | Impacto | Sev. | Correção |
|---|-----|----------------|---------|------|----------|
| 1 | **Porta SSH hardcoded 22; SSM `/shared/srv1/port` ignorado** | sshd em 22+47391; SSM tem port · `ssh.service.ts:23/115-117`, sem `SRV1_SSH_PORT` | Fechar a 22 = perda total e silenciosa de containers/systemd/load/mem/disk via SSH — a telemetria que detectaria a recorrência de junho | **Crítica** | `srv1()` ler porta do SSM `/shared/srv1/port` (ou env, fallback 22); pôr no `.env.example`; só então fechar a 22 |
| 2 | **`staggered-containers.service` FAILED + NOC cego a units failed** | 3 units failed · `SYSTEMD_TARGETS` (`srv1.service.ts:12-23`) whitelist fixa não as inclui | Defesa anti thundering-herd morta; próximo boot reabre o incidente. NOC exibe systemd "verde" | **Crítica** | (infra) rearmar o service; (código) adicionar units de mitigação ao target **e** coletar `systemctl --failed` genérico |
| 3 | **CPU proxy e breaker assumem 4 vCPU; host tem 8** | `nproc=8` · `srv1.service.ts:96-97` `load1m/4`; `metrics.scheduler.ts:34` breaker=12 | CPU reporta o **dobro** do real → alertas falsos `host_cpu_high`; breaker dispara em 1.5x cores (pula coleta sob carga moderada) | **Alta** | coletar `nproc` (cachear) como divisor; `LOAD_CIRCUIT_BREAK = 3*nproc` (=24) |
| 4 | **uptimePercent espera 60 snapshots/h; grava 12/h** | scheduler 5min = 12/h · `analytics.service.ts:178-180` `expected=hours*60` | KPI de uptime reporta ~20% com host 100% saudável → painel sem credibilidade, mascara downtime real | **Alta** | `expected = hours*12` (idealmente derivar do intervalo real, constante compartilhada) |
| 5 | **AlertRules do banco nunca avaliadas + threshold divergente** | `seed.ts:158` disco>80 · scheduler hardcoded CPU85/RAM90/disco85; rules só em CRUD | Operador cria/edita regras sem efeito nenhum; disco alerta em 85 não em 80 | **Alta** | scheduler avaliar `AlertRule` do banco, ou remover CRUD da UI e documentar; alinhar 80 vs 85 |
| 6 | **4 apps Coolify `exited` há semanas sem alerta** | libertakidz/manalista/apptecph-web/passaro-professor exited · scheduler só detecta container que sumiu no ciclo; `coolifyDeploysTick` não alerta status | Apps mortos indefinidamente sem alerta — NOC falha na função básica | **Alta** | alertar quando `app.status` contém exited/unhealthy (cooldown); ou marcar apps como desativados |
| 7 | **Defaults fallback RAM 16 GB / disco 200 GB** | real 32 GB / 387 GB · `srv1.service.ts:61/63` | Com SSH fora (gap #1), percentuais 2x inflados → alerta falso `host_mem_high` | **Média** | defaults 32 GB/400 GB, ou usar total do plano da Hostinger API |
| 8 | **Telefone default com 12 dígitos (falta um 5)** | `alerts.service.ts:18` `556598466555` vs seed `5565984665555` | Sem `ALERT_PHONE_DEFAULT`, alerta vai a número inválido — falha no canal de emergência | **Média** | corrigir literal p/ 13 díg e/ou ler `/shared/alert_phone` do SSM |
| 9 | **FQDN Coolify = sslip.io; CORS casa sslip** | app fqdn `*.sslip.io` · `main.ts:49` CORS regex sslip | Redeploy pode regenerar routing p/ sslip; CORS aberto a sslip é superfície extra | **Média** | setar fqdn correto (health check Coolify desabilitado → validar manual); restringir CORS a prod |
| 10 | **`COOLIFY_BASE_URL` default público diverge do interno** | `coolify.service.ts:15` default `https://coolify.controler.net.br` vs real `http://10.0.6.1:8000` | Se env sumir, chamada interna vira dependência de rota externa+Cloudflare; degradação silenciosa | **Média** | default `http://10.0.6.1:8000`; logar warn ao cair no default |
| 11 | **"41 containers" (comentário/docs) vs 34 reais** | 34 Up · `metrics.scheduler.ts:86`, `SRV1_INVENTORY.md` | Cosmético; inventário documental defasado | **Baixa** | atualizar comentário e `SRV1_INVENTORY.md`; contagem dinâmica |
| 12 | **Ollama baseUrl `localhost:11434` no seed** | ollama no host `*:11434`; healthUrl `10.0.6.1:11434` (ok) · `seed.ts:133` baseUrl localhost | healthUrl certo; baseUrl induz erro a consumidor futuro | **Baixa** | alinhar baseUrl p/ `http://10.0.6.1:11434` |
| 13 | **`projects` (seed) ≠ 9 projetos reais do Coolify** | 9 seed fixos com UUIDs · 9 projetos vivos diferentes | Modelo órfão/desalinhado no banco | **Baixa** | reconciliar via API ou marcar como referência estática |

**Conferências que bateram (sem gap):** parse `df` `/dev/sdX` (disco é sda1 ✓) · IDs Hostinger fixos (1379597 ✓) · host SSH default 62.72.63.18 ✓ · `postgresql@16-main` existe no host ✓.

---

## 8) Lacunas código × realidade — leitura consolidada

Dois achados dominam e devem preceder **qualquer** reharden: **(a)** mitigação de junho morta (`staggered-containers` failed) com o NOC cego a isso; **(b)** telemetria SSH inteira pendurada na porta 22 que o hardening deve fechar, com a porta correta já no SSM e não lida.

Corrigir **#1 e #2 antes do reharden**. Os itens **#3–#6** são correções de código pequenas com alto ganho de confiabilidade do painel (CPU real, uptime real, alertas que de fato disparam). **#7–#13** são higiene/reconciliação.

**Conclusão da Fase 0:** infraestrutura mapeada ao vivo, **saudável e maior do que o código pressupõe** (KVM8, não KVM4). As lacunas alimentam diretamente as próximas fases. Nada foi alterado.

---

## Próximo passo → FASE 1

Base de descoberta estabelecida. A Fase 1 parte da matriz priorizando **Crítica/Alta**: começar pela leitura da porta SSH do SSM (#1) e pelo rearme + observabilidade de systemd failed (#2), **antes** de tocar no hardening da porta 22.
