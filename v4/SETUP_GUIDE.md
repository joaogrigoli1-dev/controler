# Controler v4 — Setup Guide pós-deploy

## Status atual (2026-05-27)

✅ Código v4 commitado em `main` (commit `156e083`)
✅ App Coolify criada — UUID `a8u2gdchrpjnn6era2i8kh8d`, nome `controler-v4`
✅ Projeto Coolify: **Infraestrutura** (`wwkksgsok8wkswwsk0sskgss`)
✅ Build pack: `dockercompose` apontando para `/v4/docker-compose.yml`
✅ Branch: `main` · Base directory: `/v4`
✅ Deploy disparado — UUID `r7m93barna2pll1nck6yb1pm`
✅ Env vars principais configuradas (POSTGRES_PASSWORD, JWT_*, SRV1_SSH_*, etc)

## Pendências para você completar

### 1. DNS Cloudflare (PRIORIDADE)

O token Cloudflare do SSM está **expirado** — bloqueia a criação programática.

**Passos manuais:**
1. Acesse Cloudflare Dashboard → zona `controler.net.br`
2. DNS → Add record:
   - Type: **A**
   - Name: **controler-v4**
   - IPv4 address: **62.72.63.18**
   - Proxy status: **Proxied** ✅
   - TTL: Auto
3. Após criar, Traefik + acme.sh gera o SSL automaticamente em ~60s

**Ou via API (gere um novo token com permissão Zone.DNS:Edit em controler.net.br):**

```bash
NEW_CF_TOKEN="<seu_novo_token>"
ZONE_ID=$(curl -s -H "Authorization: Bearer $NEW_CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=controler.net.br" | jq -r '.result[0].id')
curl -X POST -H "Authorization: Bearer $NEW_CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"type":"A","name":"controler-v4","content":"62.72.63.18","proxied":true,"ttl":1}' \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records"
# Salvar o novo token no SSM:
aws ssm put-parameter --profile cowork-admin --name /controler/cloudflare_api_token --type SecureString --value "$NEW_CF_TOKEN" --overwrite
```

### 2. SSH Key para o container v4 (CRÍTICO)

O `SshService` (NestJS) precisa de chave SSH para conectar no SRV1. No `docker-compose.yml` já está montado `./ssh:/root/.ssh:ro` mas o diretório está vazio na app Coolify.

**Opções:**

**A. Chave gerada para o container** (recomendado, mais seguro)
```bash
# No SRV1, dentro do container Coolify, gerar par de chaves:
ssh root@62.72.63.18
mkdir -p /data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh
ssh-keygen -t ed25519 -N "" -f /data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh/id_ed25519 -C "controler-v4"
# Adicionar a public key no authorized_keys do próprio root:
cat /data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh/id_ed25519.pub >> /root/.ssh/authorized_keys
chmod 600 /data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh/id_ed25519
```

No Coolify UI → Volumes do `api` service: ajustar o mapping para
`/data/coolify/applications/a8u2gdchrpjnn6era2i8kh8d/ssh:/root/.ssh:ro`

**B. Reutilizar a chave do MyClinicSoft via env** (mais rápido)

Adicionar env vars `SRV1_SSH_PRIVATE_KEY` (multiline) ou usar senha em `SRV1_SSH_PASSWORD` lendo do SSM `/controler/srv1_ssh_password` (já configurado).

### 3. AWS Credentials no container

Atualmente as envs `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY` estão com placeholder `PRECISA_CONFIGURAR_VIA_UI`. Você precisa:

```bash
# 1. Criar IAM user dedicado controler-v4 com policy de acesso ao SSM /controler/* e /myclinicsoft/*
aws iam create-user --profile cowork-admin --user-name controler-v4
aws iam attach-user-policy --profile cowork-admin --user-name controler-v4 --policy-arn arn:aws:iam::aws:policy/AmazonSSMReadOnlyAccess
aws iam create-access-key --profile cowork-admin --user-name controler-v4
# 2. Pegar AccessKeyId e SecretAccessKey, atualizar no Coolify UI
```

Ou via API Coolify:
```bash
COOLIFY_TOKEN=$(aws ssm get-parameter --profile cowork-admin --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)
curl -X PATCH -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"AWS_ACCESS_KEY_ID","value":"AKIA..."}' \
  "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/envs"
curl -X PATCH -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"AWS_SECRET_ACCESS_KEY","value":"..."}' \
  "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/envs"
```

### 4. Z-API tokens (necessário para OTP login)

```bash
COOLIFY_TOKEN=$(aws ssm get-parameter --profile cowork-admin --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)
for v in ZAPI_INSTANCE_ID ZAPI_TOKEN ZAPI_CLIENT_TOKEN INFOBIP_API_KEY HOSTINGER_API_TOKEN; do
  VAL=$(aws ssm get-parameter --profile cowork-admin --name "/myclinicsoft/${v,,}" --with-decryption --query 'Parameter.Value' --output text 2>/dev/null)
  if [ -n "$VAL" ]; then
    echo "Setting $v"
    curl -s -X PATCH -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
      -d "{\"key\":\"$v\",\"value\":\"$VAL\"}" \
      "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/envs"
  fi
done
```

### 5. Coolify token interno (para o v4 falar com a API Coolify)

```bash
COOLIFY_INTERNAL=$(aws ssm get-parameter --profile cowork-admin --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)
COOLIFY_TOKEN=$(aws ssm get-parameter --profile cowork-admin --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)
curl -X PATCH -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
  -d "{\"key\":\"COOLIFY_TOKEN\",\"value\":\"$COOLIFY_INTERNAL\"}" \
  "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/envs"
curl -X PATCH -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"key":"COOLIFY_BASE_URL","value":"http://coolify:8080"}' \
  "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/envs"
```

### 6. Volume Docker socket (para SRV1Service.getContainers via socket local)

Atualmente o `docker-compose.yml` v4 já mapeia `/var/run/docker.sock:/var/run/docker.sock:ro` para o serviço `api`. Coolify normalmente respeita isso, mas verifique em **Coolify UI → controler-v4 → Storages** que o mapping está aplicado.

### 7. Primeiro acesso

Após DNS propagar (~60s):
1. Acessar https://controler-v4.net.br
2. Tela de login pede celular
3. Digite **65 98466 5555** (já está no seed)
4. Receba código no WhatsApp via Z-API
5. Login OK → Mission Control

### 8. Migrar dados do v3 → v4 (opcional)

O v3 usa SQLite em `bd/controler.db`. Se quiser preservar histórico:

```bash
ssh root@62.72.63.18
docker exec hksw4kg8owgs0wwg0o8k4kk0-065954676932 sqlite3 /app/bd/controler.db .dump > /tmp/v3_dump.sql
# Adaptar tipos SQLite→Postgres e importar:
# (script de migração será adicionado em v4.1)
```

Para uso normal, **não é necessário** — o v4 começa snapshots/timeline do zero e isso é OK.

## Checklist final (marque conforme for completando)

- [x] Código v4 no git
- [x] App Coolify criada (`a8u2gdchrpjnn6era2i8kh8d`)
- [ ] DNS controler-v4.net.br no Cloudflare (manual)
- [ ] AWS credentials reais
- [ ] Z-API tokens copiados de MyClinicSoft
- [ ] SSH key configurada para container
- [ ] Coolify token interno
- [ ] Primeiro deploy bem-sucedido
- [ ] OTP login testado
- [ ] WebSocket funcionando (badge LIVE verde no topo)
- [ ] Métricas SRV1 carregando

## Rollback / killswitch

Se algo der errado:
```bash
# Stop v4 (mantém v3 intacto):
COOLIFY_TOKEN=$(aws ssm get-parameter --profile cowork-admin --name /controler/coolify_token --with-decryption --query 'Parameter.Value' --output text)
curl -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "http://62.72.63.18:8000/api/v1/applications/a8u2gdchrpjnn6era2i8kh8d/stop"
```

O v3 (`controler.net.br`) continua intocado — UUID `hksw4kg8owgs0wwg0o8k4kk0`.
