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
