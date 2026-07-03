# Controler — Runbook

> Operação, troubleshooting e recuperação para o sistema NOC em https://noc.controler.net.br

## Healthcheck rápido (30s)

```bash
# 1. App alive
curl https://noc.controler.net.br/be-health
# { "version": "4.0.0", "status": "ok", "services": { "db": "ok", "redis": "ok" } }

# 2. Auth canais
curl https://noc.controler.net.br/be/auth/diagnostic
# zapi.connected: true | meta.configured | sms.configured

# 3. Coolify app status
mcp__coolify-mcp__coolify_get_application uuid=a8u2gdchrpjnn6era2i8kh8d
# status: running:healthy

# 4. Carga SRV1
mcp__mcp-hostinger__vps_metrics vm_id=1379597
# CPU < 80%, RAM < 80%, disk < 80%
```

## Subir local (dev)

```bash
cd ~/DEV/controler
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm --filter @controler/api prisma:generate
pnpm --filter @controler/api prisma:migrate
pnpm --filter @controler/api prisma:seed
pnpm dev
# Frontend: http://localhost:3000
# API: http://localhost:4000
```

## Deploy (DEV → GIT → PROD)

Regra absoluta: NUNCA editar prod direto. Sempre passar pelo git.

```bash
cd ~/DEV/controler
pnpm -r check                              # typecheck
pnpm --filter @controler/api test          # vitest unit
pnpm --filter @controler/web test:e2e      # playwright (opcional, demora)
git add . && git commit -m "tipo(escopo): descrição" && git push origin main
mcp__coolify-mcp__coolify_deploy uuid=a8u2gdchrpjnn6era2i8kh8d force=true
sleep 300 && curl https://noc.controler.net.br/be-health
```

## Login (3 caminhos)

### A. Normal (OTP WhatsApp)
1. https://noc.controler.net.br/login
2. Celular `65 98466 5555`
3. OTP via Z-API (canal principal). Se cair, tenta Meta, depois SMS Infobip.

### B. Backdoor admin (recuperação)
```bash
curl -X POST https://noc.controler.net.br/be/auth/dev-otp \
  -H "X-Dev-Token: $DEV_BACKDOOR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"phone":"556598466555"}'
# { "code": "123456", ... }
```

### C. INSERT direto no DB (último recurso)
```bash
ssh root@62.72.63.18
CID=$(docker ps -q --filter "name=postgres-a8u2gdchrpjnn6era" | head -1)
HASH=$(python3 -c "import hashlib; print(hashlib.sha256('123456'.encode()).hexdigest())")
docker exec $CID psql -U controler -d controler -c "
  INSERT INTO otp_tokens (id, \"userId\", \"codeHash\", channel, purpose, \"expiresAt\", used, \"createdAt\")
  SELECT 'cl_emergency_001', id, '$HASH', 'whatsapp', 'login', NOW() + INTERVAL '5 minutes', false, NOW()
  FROM users WHERE phone = '556598466555';
"
```

## Convenção de canais (João)

| Canal | Convenção |
|-------|-----------|
| **WhatsApp** | SEMPRE 2 rotas: **Z-API** (principal) + **Meta API oficial** (fallback) |
| **SMS** | SEMPRE **Infobip** |

## Tests

```bash
# Unit (Vitest)
pnpm --filter @controler/api test
pnpm --filter @controler/api test:coverage

# E2E (Playwright contra prod)
pnpm --filter @controler/web test:e2e:install   # 1ª vez (baixa Chromium)
pnpm --filter @controler/web test:e2e           # 10 spec files, ~30 testes
pnpm --filter @controler/web test:e2e:report    # HTML report

# E2E local
pnpm dev  # outro terminal
pnpm --filter @controler/web test:e2e:local
```

## Recuperar de "no available server"

Sintoma: Cloudflare 502/503, Traefik "no available server".

```bash
# 1. VPS alive?
mcp__mcp-hostinger__vps_metrics vm_id=1379597
# Se CPU > 95% por muito tempo: AGUARDAR 5-10min OU restart drástico:
# mcp__mcp-hostinger__vps_restart vm_id=1379597  (LAST RESORT)

# 2. Container status
ssh root@62.72.63.18 'docker ps --filter "name=a8u2gdchrpjnn6era" --format "{{.Names}}|{{.Status}}"'

# 3. Logs
ssh root@62.72.63.18 'docker logs --tail 50 $(docker ps -aq --filter "name=api-a8u2gdchrpjnn6era" | head -1)'

# 4. Restart
mcp__coolify-mcp__coolify_restart_application uuid=a8u2gdchrpjnn6era2i8kh8d

# 5. Se nada, redeploy
mcp__coolify-mcp__coolify_deploy uuid=a8u2gdchrpjnn6era2i8kh8d force=true
```

## Rotacionar tokens

```bash
# 1. SSM
aws ssm put-parameter --profile cowork-admin --name /shared/zapi/token --type SecureString --value "NOVO" --overwrite

# 2. Coolify env
COOLIFY_TOKEN=$(aws ssm get-parameter --profile cowork-admin --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)
curl -X PATCH -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"ZAPI_TOKEN","value":"NOVO"}' \
  "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/envs"

# 3. Redeploy + validar
mcp__coolify-mcp__coolify_deploy uuid=a8u2gdchrpjnn6era2i8kh8d force=true
curl https://noc.controler.net.br/be/auth/diagnostic
```

## Ler logs

```bash
# Via MCP
mcp__coolify-mcp__coolify_get_logs uuid=a8u2gdchrpjnn6era2i8kh8d lines=200

# Via SSH
ssh root@62.72.63.18 'docker logs --tail 100 -f $(docker ps -q --filter "name=api-a8u2gdchrpjnn6era" | head -1)'

# Coolify UI
# http://62.72.63.18:8000 → controler → Logs
```

## Rollback de deploy

```bash
# Via Coolify UI: controler → Deployments → escolher revisão anterior → Redeploy

# Via git
cd ~/DEV/controler
git log --oneline -10
git revert <sha-ruim>
git push origin main
mcp__coolify-mcp__coolify_deploy uuid=a8u2gdchrpjnn6era2i8kh8d force=true
```

## Migrations em produção (FASE 6, 2026-07)

Regra: **`db push` é PROIBIDO em prod**. O fluxo é `prisma migrate` — e o `migrate deploy`
roda **automaticamente no start do container da API** (CMD do `apps/api/Dockerfile`).
Baseline `0_baseline` foi resolvido em prod em 2026-07-02 (`prisma migrate resolve --applied 0_baseline`).

### Fluxo normal (nova migration)

```bash
# 1. Dev: criar a migration versionada
pnpm --filter @controler/api exec prisma migrate dev --name minha_mudanca

# 2. BACKUP antes de qualquer deploy que carregue migration nova
ssh root@62.72.63.18   # porta 47391
CID=$(docker ps -q --filter "name=postgres-a8u2gdchrpjnn6era" | head -1)
docker exec $CID pg_dump -U controler controler | gzip > /root/backups/controler-pre-<tag>-$(date +%Y%m%d-%H%M).sql.gz
gzip -t /root/backups/controler-pre-<tag>-*.sql.gz   # valida o arquivo

# 3. Push + deploy — o container aplica as migrations pendentes sozinho no boot
git push origin main && mcp__coolify-mcp__coolify_deploy uuid=a8u2gdchrpjnn6era2i8kh8d force=true

# 4. Conferir no log do boot da API: "migrate deploy" + health
curl https://noc.controler.net.br/be-health
```

### Rollback de migration

Prisma não tem "migrate down" — rollback = **restaurar backup + voltar o código**:

```bash
# 1. Restaurar o dump pré-migration (ex.: /root/backups/controler-pre-fase6-20260702-2113.sql.gz)
ssh root@62.72.63.18
CID=$(docker ps -q --filter "name=postgres-a8u2gdchrpjnn6era" | head -1)
gunzip -c /root/backups/controler-pre-<tag>.sql.gz | docker exec -i $CID psql -U controler -d controler

# 2. Redeploy do commit anterior (git revert ou Coolify UI → revisão anterior)
# 3. Health check manual obrigatório
curl https://noc.controler.net.br/be-health
```

## Coletores (FASE 3) — verificação e troubleshooting

Coletores raw a cada **60s** (host + 33 containers), env de escape `NOC_RAW_INTERVAL_MS`
(ex.: `300000` = 5min). SSL probe 6/6h, deploys Coolify 5/5min, rollups horário/diário.

### Verificar se estão gravando

```bash
# Contagem de linhas nas tabelas novas (deve crescer a cada minuto)
CID=$(docker ps -q --filter "name=postgres-a8u2gdchrpjnn6era" | head -1)
docker exec $CID psql -U controler -d controler -c "
  SELECT 'container_metric_points' t, count(*), max(ts) FROM container_metric_points
  UNION ALL SELECT 'host_metric_snapshots', count(*), max(\"createdAt\") FROM host_metric_snapshots
  UNION ALL SELECT 'host_disk_io_points', count(*), max(ts) FROM host_disk_io_points
  UNION ALL SELECT 'ssl_check_history', count(*), max(\"checkedAt\") FROM ssl_check_history
  UNION ALL SELECT 'deploy_history', count(*), max(\"createdAt\") FROM deploy_history;"

# Logs do scheduler (procurar por [Scheduler], [Rollup], [SslScheduler], [DeploysScheduler])
docker logs --tail 100 $(docker ps -q --filter "name=api-a8u2gdchrpjnn6era" | head -1) 2>&1 | grep -Ei "scheduler|rollup|ssl"
```

### Troubleshooting do SSH do coletor

Sintoma: `host metrics failed` / `container metrics failed` nos logs, tabelas paradas.

- A chave é **montada pelo Coolify em `/root/.ssh/id_ed25519`** dentro do container da API;
  o env **`SRV1_SSH_KEY_PATH=/root/.ssh/id_ed25519`** (env do app no Coolify) aponta para ela.
- O SshService tenta uma **cadeia de chaves candidatas** (env → SSM `private_key_path` → defaults);
  cuidado: o SSM `/controler/srv1/private_key_path` pode conter path do Mac
  (`~/.ssh/id_ed25519_cowork`) que NÃO existe no container — o env tem precedência.
- sshd do SRV1 tem `PasswordAuthentication no` → sem chave válida não há fallback.

```bash
# Dentro do container da API: chave existe? conecta?
docker exec $(docker ps -q --filter "name=api-a8u2gdchrpjnn6era" | head -1) \
  sh -c 'ls -la /root/.ssh/ && ssh -p 47391 -o BatchMode=yes -o StrictHostKeyChecking=no root@62.72.63.18 uptime'
```

## Systemd units do SRV1 — fixes de 2026-07-02

Os 3 units failed da FASE 0 foram corrigidos (`systemctl --failed` = 0 agora). O que foi feito
e como reverter:

| Unit | Causa | Fix aplicado | Reverter |
|------|-------|--------------|----------|
| `staggered-containers.service` | script sem bit de execução | `chmod 755` no script (ExecStart) | n/a (fix trivial) |
| `redis-server.service` | `bind 10.0.1.1` — IP de bridge docker que sobe DEPOIS do redis | bind tolerante `-10.0.1.1` em `/etc/redis/redis.conf` + drop-in `After=network-online.target docker.service` | remover o `-` do bind e apagar o drop-in em `/etc/systemd/system/redis-server.service.d/` |
| `ssh-emergency.service` | dependia de `ssh.socket`, ausente no Ubuntu 24 | `ExecStart=-...` (best-effort, não marca failed) | remover o `-` do ExecStart |

```bash
# Conferir
ssh -p 47391 root@62.72.63.18 'systemctl --failed --no-legend; redis-cli -h 127.0.0.1 ping'
# redis ouve em 127.0.0.1 e 10.0.1.1
```

---

## POSTMORTEM — Incidente 28/05/2026 (8h-10h BRT)

### Resumo
SshService tinha bug crítico (`isConnected?.()` inexistente em node-ssh) que criava conexão SSH nova a cada chamada. Schedulers a cada 30s × 41 containers monitorados = SRV1 sshd começou a rejeitar com "Channel open failure". Cascade: Postgres connection drop → containers unhealthy → Traefik 503. CPU SRV1 chegou a 100%. VPS acabou reiniciando.

### Impacto
- `controler` NOC inacessível ~90min
- `MyClinicSoft` derrubado junto (mesma máquina) ~30min até auto-recovery
- Outros containers (libertakidz, manalista, fisiomt, passaro, mailserver) continuaram OK em network isolada

### Root cause
```typescript
// ssh.service.ts (versão buggy)
if (existing && (existing as any).isConnected?.()) return existing;
// node-ssh NÃO TEM isConnected — sempre falsy → sempre conexão nova
```

### Fix aplicado (commit 380ccac)
1. Usa `.connection` (raw client) com `.destroyed` check
2. Keepalive 30s + max 3 retries
3. Auto-cleanup on `close`/`error`
4. Coalesce concurrent connects
5. Intervalos relaxados: 30s→60s, 5min→15min, 2min→5min, 10min→30min

### Fix de degradação (commit aa01b8d)
Hostinger API demora 5-30min para popular métricas pós-reboot. Service agora faz fallback ao SSH (`free -b`, `df -B1`, `/proc/uptime`) quando Hostinger retorna 0.

### Lições
1. **TypeScript `?.()` em método inexistente compila** — sempre testar com sample real.
2. **Pools de conexão são obrigatórios** para qualquer recurso externo limitado (SSH, DB).
3. **Schedulers devem alertar quando carga do próprio host alta** (agora dispara `host_cpu_high` se CPU>85%).
4. **Backdoor admin é essencial** para recuperação quando OTP/SMS falham.

### Como prevenir no futuro
- `pnpm test:e2e` antes de push que toca scheduler/SSH
- Monitorar alertas `host_cpu_high` no WhatsApp
- Se ver "no available server": **primeiro** `vps_metrics` (não restartar à toa)

## Contatos
- João Henrique Grigoli — +55 65 98466 5555 (único responsável)
- Z-API support: support@z-api.io
- Hostinger: painel.hostinger.com
- AWS billing: console.aws.amazon.com
