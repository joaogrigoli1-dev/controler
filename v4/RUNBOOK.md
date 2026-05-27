# Controler v4 — Runbook

## Saúde do sistema

```bash
curl -s https://controler-v4.net.br/api/v1/health | jq
# { "version": "4.0.0", "status": "ok", "services": { "db": "ok", "redis": "ok" } }
```

## Subir local (dev)

```bash
cd v4
cp .env.example .env
pnpm install
docker compose up -d postgres redis
pnpm --filter @controler/api prisma:migrate
pnpm --filter @controler/api prisma:seed
pnpm dev
```

Frontend: http://localhost:3000  
API: http://localhost:4000

## Deploy (DEV → GIT → PROD)

Regra absoluta (CLAUDE.md global): **NUNCA editar prod direto**.

```bash
cd ~/Documents/DEV/controler
# 1. typecheck
cd v4 && pnpm check
# 2. commit
cd ..
git add v4/
git commit -m "feat(v4): <descrição>"
git push origin main
# 3. coolify deploy (via MCP ou UI)
```

## Forçar redeploy da app v4 no Coolify

Via MCP no Claude:
```
coolify_deploy uuid=<UUID-V4> force=true
```

Via curl:
```bash
curl -X GET "https://coolify.controler.net.br/api/v1/deploy?uuid=<UUID-V4>&force=true" \
  -H "Authorization: Bearer $(aws ssm get-parameter --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)"
```

## Resetar database

⚠️ DESTRUTIVO — só em dev.

```bash
cd v4/apps/api
pnpm prisma migrate reset --force
pnpm prisma:seed
```

## Adicionar novo usuário

Via Prisma Studio:
```bash
cd v4/apps/api
pnpm prisma:studio
# abrir http://localhost:5555, tabela User, criar
```

Ou via script:
```bash
cd v4/apps/api
pnpm tsx -e "
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
await p.user.create({ data: { name: 'Fulano', email: 'f@x.com', phone: '5511999999999', role: 'admin' } });
process.exit();
"
```

## Recuperar acesso (se OTP falhar)

Z-API pode estar fora. Bypass temporário:
1. Conectar Postgres direto:
   ```bash
   ssh root@62.72.63.18
   docker exec -it postgres-main psql -U controler controler_v4
   ```
2. Inserir OTP manualmente:
   ```sql
   INSERT INTO otp_tokens (id, user_id, code_hash, channel, purpose, expires_at, used)
   VALUES (
     'cl_manual_001',
     (SELECT id FROM users WHERE phone = '556598466555'),
     encode(digest('123456', 'sha256'), 'hex'),
     'whatsapp',
     'login',
     NOW() + INTERVAL '10 minutes',
     false
   );
   ```
3. Login no UI usando o código `123456`.

## Quando container fica unhealthy

```bash
# 1. Logs
ssh root@62.72.63.18 'docker logs --tail 200 <container-name>'
# 2. Verifica health
ssh root@62.72.63.18 'docker inspect --format "{{json .State.Health}}" <container-name>' | jq
# 3. Restart se necessário (via UI vault + OTP, ou direto):
ssh root@62.72.63.18 'docker restart <container-name>'
```

## Monitorar performance

```bash
# Métricas em tempo real
curl -H "Authorization: Bearer $TOKEN" \
  https://controler-v4.net.br/api/v1/srv1/host | jq

# Histórico CPU/RAM 24h
curl -H "Authorization: Bearer $TOKEN" \
  https://controler-v4.net.br/api/v1/analytics/host/history?hours=24 | jq
```

## Incidente: Z-API banida

Replicar decisão do MyClinicSoft (25/05/2026):
1. Confirmar via tentativa de envio manual:
   ```bash
   curl -X POST "https://api.z-api.io/instances/$ZAPI_INSTANCE/token/$ZAPI_TOKEN/send-text" \
     -d '{"phone": "...", "message": "test"}'
   ```
2. Se 403/disconnected: ativar kill-switch (env var `ZAPI_KILL_SWITCH=true`)
3. OTP fica off → usar bypass manual de OTP (acima)
4. Solicitar novo número Z-API e atualizar SSM

## Limpeza de disco SRV1

Via UI: tela Scanner → "Fix" nas findings safe.

Manual:
```bash
ssh root@62.72.63.18 'docker image prune -f && docker builder prune -f --keep-storage 1g'
# libera ~12GB tipicamente
```

## DNS

Cloudflare gerencia os domínios principais. Para criar subdomínio:
```bash
# Via MCP Cloudflare (futuro)
# Manual: https://dash.cloudflare.com → Zone → DNS → Add record
# Type: A, Name: controler-v4, Value: 62.72.63.18, Proxy: ON
```

Após criar o DNS, Traefik+acme.sh gera o SSL automaticamente em ~30s.

## Rollback de deploy

```bash
# Achar último commit estável
git log --oneline v4/ | head -10

# Coolify UI → Deployments → escolher revisão anterior → Redeploy
```

## Contatos de emergência

- Único responsável: João Henrique Grigoli (+55 65 98466 5555)
- Z-API support: support@z-api.io
- Hostinger support: via painel
- AWS billing: console.aws.amazon.com
