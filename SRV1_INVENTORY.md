# SRV1 — Inventário Completo (varrido 2026-05-27)

Servidor: **srv1379597.hstgr.cloud** (IP `62.72.63.18`, IPv6 `2a02:4780:14:44ba::1`)

## Hardware / OS

| Item | Valor |
|------|-------|
| Plano | Hostinger KVM 4 |
| vCPU | 4 |
| RAM | 16 GB (4.8GB usados / 1.5GB livre / 10GB cache) |
| Disco | 200 GB (91GB usados — 47%) |
| OS | Ubuntu 24.04.4 LTS (Noble) |
| Kernel | 6.8.0-110-generic |
| Uptime | 26 dias 19h |
| Load avg | 1.22 / 1.19 / 1.23 |
| Swap | 4 GB (apenas 75MB usado) |

## Firewall (Hostinger group 234899 — `srv1-main-firewall`)

| Porta | Protocolo | Origem | Uso |
|-------|-----------|--------|-----|
| 22 | TCP | 0.0.0.0/0 | SSH padrão |
| 80 | TCP | 0.0.0.0/0 | HTTP (Traefik) |
| 443 | TCP | 0.0.0.0/0 | HTTPS (Traefik) |
| 47391 | TCP | any | SSH externo (key-only desde 2026-06-06; porta 22 só interna p/ Coolify, 2222 desativada) |
| 8000 | TCP | 0.0.0.0/0 | Coolify UI |
| 18789 | TCP | 0.0.0.0/0 | Coolify (extra) |
| 25/465/587 | TCP | 0.0.0.0/0 | SMTP (mailserver) |
| 143/993 | TCP | 0.0.0.0/0 | IMAP (mailserver) |

⚠ **Não sincronizado** (`is_synced: false`) — provavelmente bloqueado por iptables local.

## Stacks identificadas (38 containers rodando)

### 1. Coolify (orquestrador)
- `coolify` (4.1.0) — UI principal `:8000`
- `coolify-db` (postgres:15)
- `coolify-redis`
- `coolify-realtime` (porta 6001/6002)
- `coolify-sentinel`
- `coolify-proxy` (Traefik v3.6) — gerencia 80/443/8080

### 2. Apps Coolify (7 produção)
| App | UUID | URL | Status | RAM |
|-----|------|-----|--------|-----|
| **controler** | `hksw4kg8owgs0wwg0o8k4kk0` | controler.net.br | healthy | 135 MiB |
| **myclinicsoft** | `jckc0ccwssowwc0oocw80ogs` | myclinicsoft.com.br | healthy | 198 MiB |
| **libertakidz-backend** | `yow040wosgowks8o80gk88g4` | libertakidz.com.br | healthy | 47 MiB |
| **manalista** | `x4g4sgw48s4s84wg8kkggs8g` | manalista.com.br | running | 54 MiB |
| **fisiomt-laudo** | `rc8gwc0c008008sg8c88gos0` | laudo.fisiomt.com.br | running | 4.7 MiB |
| **fisiomt-painel** | `gc4088ks8cws48kskcksgsg8` | painel.fisiomt.com.br | running | 4.9 MiB |
| **passaro-professor** | `v8so4ocgkkkk8ows48skggcg` | passaroprofessor.com.br | running | 48 MiB |

### 3. Mail server (stalwart + docker-mailserver)
- `mailserver` (docker-mailserver) — SMTP/IMAP completo
- `roundcube` (webmail principal)
- `roundcube-fisiomt`, `roundcube-clinicafisiomt`, `roundcube-trimec` — webmails dedicados por marca

### 4. Sites nginx estáticos / PHP
- `fisiomt-web-b12yx8w9...` (nginx:alpine)
- `clinicafisiomt-web-e2ab2543...` (nginx:alpine)
- `trimec-web` (nginx:alpine)
- `passaro-web-...` (PHP 7.2 + ionCube) — legado
- `passaro-manual-...` (nginx)
- `t4net-web-mxyztt2n...` (nginx)

### 5. Nextcloud
- `nextcloud-dzsg3ewo...` (337 MiB RAM — 7.31GB tráfego in)
- `nextcloud-redis-dzsg3ewo...`

### 6. xospam (stack inteira IA)
- `xospam_api` (Python — 382 MiB)
- `xospam_web` (Next.js? 41 MiB)
- `xospam_admin` (33 MiB)
- `xospam_postgres` (postgres:17)
- `xospam_redis` (valkey)
- `xospam_ollama` (LLM local — limitado a 6 GiB)

### 7. Databases standalone
- `postgres-main` (postgres:16) em `127.0.0.1:5433` — backup diário 3h via cron
- `mariadb-sites` (mariadb:10.11) — 228 MiB, 6.87 GB tráfego
- Redis instances dedicados: `myclinicsoft-redis`, `manalista-redis`, `libertakidz-redis`
- `libertakidz-postgres` (postgres:16)

## Serviços systemd ativos

```
clamav-daemon, clamav-freshclam (985 MB RAM — antivírus xospam)
containerd, docker
cron
dbus
fail2ban
ollama (LLM standalone, porta :11434)
pm2-root (Node.js apps gerenciadas)
postgresql@16-main (Postgres standalone na host)
ssh
qemu-guest-agent
unattended-upgrades
```

## ⚠ Serviços com FALHA (precisam atenção)

| Serviço | Estado | Ação sugerida |
|---------|--------|---------------|
| `openclaw-node.service` | not-found, failed | Remover unit file (já não usa) |
| `redis-server.service` | loaded, failed | Migrou para Docker — remover |
| `ssh-emergency.service` | loaded, failed | Investigar / remover |

## Cron jobs root

```cron
0 3 * * * /opt/backups/postgres/backup.sh                          # backup diário
0 3 * * * /usr/local/bin/xospam-clamav-scan.sh                     # scan xospam
0 3 * * * /opt/stalwart-mail/extract-traefik-certs.sh              # certs mail
11 4 * * * /root/.acme.sh/acme.sh --cron                           # renovação SSL
*/5 * * * * /opt/scripts/fix-stuck-deployments.sh                  # auto-fix Coolify
```

## /opt — projetos no host

```
/opt/backups/postgres/   ← backups diários
/opt/fisiomt/            ← arquivos legados FisioMT
/opt/libertakidz/        ← idem
/opt/nextcloud-nfe-mcp-server/
/opt/postgres-main/      ← compose do postgres standalone
/opt/roundcube/          ← stack roundcube
/opt/scripts/            ← auto-fix Coolify
/opt/stalwart-mail/      ← stack mail completa
```

## Docker disk usage

| Item | Total | Ativo | Tamanho | Reclaimable |
|------|-------|-------|---------|-------------|
| Images | 38 | 28 | 26.59 GB | **9.76 GB (36%)** ⚠ |
| Containers | 38 | 38 | 15.59 GB | 0 B |
| Volumes | 16 | 8 | 1.73 GB | 49 MB |
| Build Cache | 57 | 0 | 6.77 GB | **2.18 GB** ⚠ |

**Limpeza segura recomendada:** `docker image prune -f` + `docker builder prune -f` → libera ~12GB.

## Top consumidores (estado atual)

**CPU:**
1. `dockerd` (4.1%)
2. `php artisan horizon:work` (xospam workers) — 2.9%
3. `containerd` (2.3%)
4. `mariadbd` (2.0%)
5. `python controler.py` (0.8%)

**Memória:**
1. `clamd` (986 MB — clamav)
2. `mariadbd` (253 MB)
3. `node dist/index.cjs` (205 MB)
4. `python controler.py` (150 MB)
5. `dockerd` (140 MB)

## ⚠ Descoberta crítica

**HestiaCP NÃO está instalado neste SRV1.**  
O comando `/usr/local/hestia/bin/v-list-users` retornou vazio.  
A tela "HestiaCP" do prompt original será re-escopada para:

→ **"Mail & Sites"** — gestão consolidada de:
  - 1 Stalwart mail server
  - 4 instâncias Roundcube
  - 1 Nextcloud
  - 6 sites nginx estáticos
  - 1 site PHP legacy (passaro)
  - Status SSL via Traefik / acme.sh

## DNS / Domínios

Hostinger `domains_list` retornou `[]` — todos os domínios estão registrados em **outros registrars (Registro.br, Cloudflare, GoDaddy)**, não na Hostinger.

Domínios em uso (descobertos via apps Coolify + nginx containers):
- controler.net.br
- myclinicsoft.com.br
- libertakidz.com.br + app.libertakidz.com.br + www.
- manalista.com.br + www.
- laudo.fisiomt.com.br
- painel.fisiomt.com.br
- passaroprofessor.com.br + www.
- fisiomt.com.br
- clinicafisiomt.com.br
- trimec.com.br (suspeita — tem container web + roundcube)
- t4net (domínio principal desconhecido)
- + subdomínios mail.*

## Capacidade restante (próximas decisões)

- **CPU**: 30% livre — ok para mais 2-3 apps pequenas
- **RAM**: 10 GB livres (incluindo cache) — ok
- **Disco**: 103 GB livres + ~12 GB reclamáveis = **115 GB** — ok
- **Postgres-main** já existe em `:5433` → controler-v4 vai criar database `controler_v4` reutilizando essa instância (economiza 100 MB RAM vs novo container)

## Recomendações que o v4 vai aplicar

1. ✅ Monitorar todos os 38 containers (não só os 7 Coolify)
2. ✅ Adicionar 3 serviços systemd ao Status (clamav, ollama, pm2-root)
3. ✅ Card "Mail Stack" dedicado (mailserver + 4 roundcubes + stalwart)
4. ✅ Card "xospam Stack" dedicado (6 containers)
5. ✅ Alertar serviços failed (3 atualmente)
6. ✅ Cron jobs visíveis com last-run status
7. ✅ Botão "Limpeza segura" para `docker image prune` (+12GB)
8. ✅ Postgres compartilhado: usar `postgres-main:5433` como DB do v4 (criar db `controler_v4`)
