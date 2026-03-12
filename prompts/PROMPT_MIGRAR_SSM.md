# PROMPT — Migração de Credenciais para AWS SSM Parameter Store

> **Cole este prompt inteiro na sessão de cada app em desenvolvimento.**
> Ele é autocontido: contém inventário SSM, credenciais AWS de acesso, módulos prontos e checklist de limpeza.

---

## CONTEXTO

Estou migrando **todos os segredos** (senhas, tokens, API keys) dos meus projetos para o **AWS Systems Manager Parameter Store** com **SecureString / KMS**.

Os parâmetros já foram provisionados no SSM. Sua tarefa é:

1. **AUDITAR** — escanear todo o código do app buscando credenciais hardcoded, `.env`, `process.env.*`, variáveis sensíveis
2. **INTEGRAR** — criar um módulo centralizado que busca os segredos do SSM em vez de `.env`
3. **LIMPAR** — remover todas as credenciais do código-fonte e dos arquivos `.env` comprometidos
4. **VALIDAR** — garantir que nenhum segredo restou no código ou no histórico git recente

---

## CREDENCIAIS AWS PARA ACESSO AO SSM

Use o **perfil IAM `cowork-admin`** (AdministratorAccess) para ler os parâmetros:

```
AWS_PROFILE=cowork-admin
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=<VER_SSM_ou_cowork-admin_profile>
AWS_SECRET_ACCESS_KEY=<VER_SSM_credentialsVaws-admin_secret_key>
```

> **IMPORTANTE:** Essas credenciais são para DESENVOLVIMENTO LOCAL apenas.
> Em PRODUÇÃO (Coolify/Docker), as credenciais devem ser passadas via variáveis de ambiente do container ou IAM Role.

---

## INVENTÁRIO COMPLETO — Parâmetros já no SSM (36 total)

### Convenção de nomes: `/{serviço}/{parâmetro}` (todos SecureString/KMS)

```
/claude_api/api_key                         # Anthropic API key
/claude_api/project                         # Project name (navegador_cowork)

/cloudflare/token                           # Cloudflare API token

/credentials/aws-admin/access_key           # IAM cowork-admin access key
/credentials/aws-admin/account_id           # AWS Account ID (178701498845)
/credentials/aws-admin/region               # us-east-1
/credentials/aws-admin/secret_key           # IAM cowork-admin secret key
/credentials/aws-admin/user                 # cowork-admin

/credentials/aws-rekognition/access_key_id  # IAM myclinicsoft-rekognition access key
/credentials/aws-rekognition/secret_access_key  # IAM myclinicsoft-rekognition secret key
/credentials/aws-rekognition/region         # us-east-1

/openclaws/libertakidz/api_key             # OpenClaws API key para LibertaKidz
/openclaws/myclinicsoft/api_key            # OpenClaws API key para myclinicsoft
/openclaws/xospam/api_key                 # OpenClaws API key para XoSpam

/smtp/host                                  # mail.libertakidz.com.br
/smtp/port                                  # 587
/smtp/mode                                  # STARTTLS
/smtp/admin_user                            # admin
/smtp/admin_pass                            # Stalwart admin password
/smtp/admin_url                             # Stalwart admin panel URL
/smtp/controler_email                       # noreply@controler.net.br
/smtp/controler_user                        # noreply-controler
/smtp/controler_pass                        # Controler SMTP password
/smtp/myclinicsoft_email                    # noreply@myclinicsoft.com.br
/smtp/myclinicsoft_user                     # noreply-myclinicsoft
/smtp/myclinicsoft_pass                     # myclinicsoft SMTP password
/smtp/xospam_email                          # noreply@xospam.com.br
/smtp/xospam_user                           # noreply-xospam
/smtp/xospam_pass                           # xospam SMTP password
/smtp/xospam_dev_email                      # dev@xospam.com.br
/smtp/xospam_dev_user                       # devxospam
/smtp/xospam_dev_pass                       # xospam dev SMTP password

/srv1/host                                  # 62.72.63.18 (servidor produção)
/srv1/port                                  # SSH port
/srv1/username                              # SSH username
/srv1/password                              # SSH password
```

---

## MAPEAMENTO POR PROJETO

Cada app deve buscar APENAS os parâmetros que precisa:

| App | Parâmetros SSM que usa |
|-----|----------------------|
| **myclinicsoft** | `/smtp/myclinicsoft_*`, `/credentials/aws-rekognition/*`, `/openclaws/myclinicsoft/*`, `/srv1/*` |
| **xospam** | `/smtp/xospam_*`, `/smtp/xospam_dev_*`, `/openclaws/xospam/*` |
| **LibertaKidz** | `/smtp/host`, `/smtp/port`, `/smtp/mode`, `/openclaws/libertakidz/*` |
| **controler** | `/claude_api/*`, `/srv1/*`, `/cloudflare/*`, `/smtp/controler_*`, `/credentials/aws-admin/*` |
| **navnet** | `/claude_api/*`, `/credentials/aws-admin/*` |

---

## PASSO 1 — AUDITORIA DO CÓDIGO

Execute esta auditoria completa no código do app:

```bash
#!/bin/bash
# audit-secrets.sh — Busca credenciais hardcoded no código
echo "========================================="
echo " AUDITORIA DE SEGREDOS — $(basename $(pwd))"
echo "========================================="

# 1. Buscar padrões suspeitos no código (excluindo node_modules, dist, .git)
echo ""
echo "🔍 Buscando padrões de credenciais hardcoded..."
grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.py" \
  --include="*.yaml" --include="*.yml" --include="*.json" --include="*.sh" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=.next \
  -E '(password|passwd|secret|token|api_key|apikey|access_key|private_key)\s*[:=]\s*["\x27][^"\x27]{8,}' . \
  2>/dev/null | grep -v "placeholder" | grep -v "example" | grep -v "CHANGE_ME"

# 2. Buscar AWS keys hardcoded (padrão AKIA...)
echo ""
echo "🔑 Buscando AWS Access Keys hardcoded..."
grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  -E 'AKIA[0-9A-Z]{16}' . 2>/dev/null

# 3. Buscar .env files com valores reais (não placeholders)
echo ""
echo "📋 Arquivos .env encontrados:"
find . -name ".env*" -not -path "*/node_modules/*" -not -path "*/.git/*" | while read f; do
  SECRETS=$(grep -cE '^[A-Z_]+=.{8,}' "$f" 2>/dev/null)
  echo "  $f — $SECRETS possíveis segredos"
done

# 4. Verificar se .env está no .gitignore
echo ""
echo "🛡️ Verificando .gitignore..."
if grep -q "\.env" .gitignore 2>/dev/null; then
  echo "  ✅ .env está no .gitignore"
else
  echo "  ❌ .env NÃO está no .gitignore — RISCO!"
fi

# 5. Verificar histórico git por segredos commitados
echo ""
echo "📜 Verificando últimos 50 commits por segredos..."
git log --oneline -50 --diff-filter=A -- "*.env" ".env*" 2>/dev/null | head -10
git log --all --oneline -20 -- "*.env" 2>/dev/null | head -5

echo ""
echo "========================================="
echo " FIM DA AUDITORIA"
echo "========================================="
```

**Monte uma tabela com o resultado:**

| Arquivo | Linha | Variável | Valor atual | Parâmetro SSM correspondente |
|---------|-------|----------|-------------|------------------------------|
| `.env` | 12 | `SMTP_HOST` | `mail.libertakidz.com.br` | `/smtp/host` |
| ... | ... | ... | ... | ... |

---

## PASSO 2 — MÓDULO CENTRALIZADO DE ACESSO AO SSM

### Para apps TypeScript/Node.js (myclinicsoft, xospam, LibertaKidz, navnet)

Crie `src/lib/ssm.ts` (ou `src/config/ssm.ts`):

```typescript
/**
 * SSM Parameter Store — Módulo centralizado
 *
 * Busca segredos do AWS SSM com:
 * - Cache em memória (5 min TTL)
 * - Retry com backoff exponencial
 * - Fallback para .env local em dev (quando SSM indisponível)
 * - Tipagem forte
 */

import { SSMClient, GetParameterCommand, GetParametersByPathCommand } from '@aws-sdk/client-ssm';

// ── Config ────────────────────────────────────────────────
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos
const MAX_RETRIES = 3;
const SSM_REGION = 'us-east-1';

// ── Cache ─────────────────────────────────────────────────
const cache = new Map<string, { value: string; expiresAt: number }>();

// ── Client (lazy init) ────────────────────────────────────
let _client: SSMClient | null = null;

function getClient(): SSMClient {
  if (!_client) {
    _client = new SSMClient({
      region: SSM_REGION,
      // Em dev local: usa AWS_PROFILE=cowork-admin ou variáveis de ambiente
      // Em produção (Docker/Coolify): usa IAM Role ou env vars do container
      ...(process.env.AWS_ACCESS_KEY_ID && {
        credentials: {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
        },
      }),
    });
  }
  return _client;
}

// ── Buscar um parâmetro ───────────────────────────────────
export async function getSSMParam(name: string): Promise<string> {
  // 1. Checar cache
  const cached = cache.get(name);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.value;
  }

  // 2. Buscar do SSM com retry
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const resp = await getClient().send(
        new GetParameterCommand({ Name: name, WithDecryption: true })
      );
      const value = resp.Parameter?.Value;
      if (!value) throw new Error(`SSM param ${name} is empty`);

      // 3. Cachear
      cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
      return value;
    } catch (err) {
      lastError = err as Error;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 500));
      }
    }
  }

  // 4. Fallback para process.env em dev local
  const envKey = name.replace(/\//g, '_').replace(/^_/, '').toUpperCase();
  const envValue = process.env[envKey];
  if (envValue) {
    console.warn(`⚠️ SSM falhou para ${name}, usando fallback .env (${envKey})`);
    return envValue;
  }

  throw new Error(`SSM param ${name} indisponível após ${MAX_RETRIES} tentativas: ${lastError?.message}`);
}

// ── Buscar vários parâmetros por path prefix ──────────────
export async function getSSMParamsByPath(path: string): Promise<Record<string, string>> {
  const cacheKey = `__path__${path}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return JSON.parse(cached.value);
  }

  const result: Record<string, string> = {};
  let nextToken: string | undefined;

  do {
    const resp = await getClient().send(
      new GetParametersByPathCommand({
        Path: path,
        Recursive: true,
        WithDecryption: true,
        MaxResults: 10,
        NextToken: nextToken,
      })
    );
    for (const p of resp.Parameters ?? []) {
      const key = p.Name!.replace(path, '').replace(/^\//, '');
      result[key] = p.Value!;
      // Cachear individualmente também
      cache.set(p.Name!, { value: p.Value!, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    nextToken = resp.NextToken;
  } while (nextToken);

  cache.set(cacheKey, { value: JSON.stringify(result), expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

// ── Invalidar cache (útil para refresh manual) ────────────
export function clearSSMCache(): void {
  cache.clear();
}

// ── Helper: carregar config SMTP do app ───────────────────
export async function loadSMTPConfig(appName: string) {
  const [host, port, mode, email, user, pass] = await Promise.all([
    getSSMParam('/smtp/host'),
    getSSMParam('/smtp/port'),
    getSSMParam('/smtp/mode'),
    getSSMParam(`/smtp/${appName}_email`),
    getSSMParam(`/smtp/${appName}_user`),
    getSSMParam(`/smtp/${appName}_pass`),
  ]);
  return { host, port: parseInt(port), secure: mode === 'SSL', auth: { user, pass }, from: email };
}
```

**Instalar dependência:**
```bash
npm install @aws-sdk/client-ssm
```

### Para apps Python (controler)

O controler já tem integração SSM em `controler.py` (função `_fetch_ssm_parameters()`).
Para outros scripts Python, use:

```python
"""ssm_config.py — Módulo centralizado SSM para Python"""
import time, os

_cache: dict = {}
_CACHE_TTL = 300  # 5 min

def get_ssm_param(name: str) -> str:
    """Busca um parâmetro do SSM com cache."""
    now = time.time()
    if name in _cache and (now - _cache[name]['ts']) < _CACHE_TTL:
        return _cache[name]['value']

    import boto3
    session = boto3.Session(
        profile_name=os.environ.get('AWS_PROFILE', 'cowork-admin'),
        region_name='us-east-1'
    )
    ssm = session.client('ssm')
    try:
        resp = ssm.get_parameter(Name=name, WithDecryption=True)
        value = resp['Parameter']['Value']
        _cache[name] = {'value': value, 'ts': now}
        return value
    except Exception as e:
        # Fallback para env var
        env_key = name.strip('/').replace('/', '_').upper()
        env_val = os.environ.get(env_key)
        if env_val:
            print(f"⚠️ SSM falhou para {name}, usando fallback env ({env_key})")
            return env_val
        raise RuntimeError(f"SSM param {name} indisponível: {e}")
```

---

## PASSO 3 — INTEGRAÇÃO NO APP

### 3.1 Substituir todas as referências a `process.env.VARIAVEL`

**ANTES (código atual):**
```typescript
const smtpHost = process.env.SMTP_HOST;
const smtpPass = process.env.SMTP_PASSWORD;
const awsKey = process.env.AWS_ACCESS_KEY_ID;
```

**DEPOIS (com SSM):**
```typescript
import { getSSMParam, loadSMTPConfig } from '@/lib/ssm';

// Na inicialização do app (await no startup):
const smtpConfig = await loadSMTPConfig('myclinicsoft'); // ou 'xospam', 'controler'
const awsKey = await getSSMParam('/credentials/aws-rekognition/access_key_id');
```

### 3.2 Config de inicialização (startup do app)

Crie `src/config/index.ts`:

```typescript
import { getSSMParam, getSSMParamsByPath } from '@/lib/ssm';

export interface AppConfig {
  smtp: { host: string; port: number; secure: boolean; auth: { user: string; pass: string }; from: string };
  // Adicione mais conforme o app precisa
}

let _config: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (_config) return _config;

  // Carregar tudo em paralelo para performance
  const [smtpHost, smtpPort, smtpMode, smtpEmail, smtpUser, smtpPass] = await Promise.all([
    getSSMParam('/smtp/host'),
    getSSMParam('/smtp/port'),
    getSSMParam('/smtp/mode'),
    getSSMParam('/smtp/APP_NAME_email'),   // ← SUBSTITUA APP_NAME
    getSSMParam('/smtp/APP_NAME_user'),    // ← SUBSTITUA APP_NAME
    getSSMParam('/smtp/APP_NAME_pass'),    // ← SUBSTITUA APP_NAME
  ]);

  _config = {
    smtp: {
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: smtpMode === 'SSL',
      auth: { user: smtpUser, pass: smtpPass },
      from: smtpEmail,
    },
  };

  return _config;
}
```

### 3.3 Para ambiente de PRODUÇÃO (Docker/Coolify)

No `docker-compose.yml` ou nas variáveis do Coolify, defina APENAS:

```yaml
environment:
  AWS_ACCESS_KEY_ID: "<ver_aws_credentials_no_cowork-admin_profile>"
  AWS_SECRET_ACCESS_KEY: "<ver_aws_credentials_no_cowork-admin_profile>"
  AWS_REGION: "us-east-1"
  NODE_ENV: "production"
```

O app usa essas credenciais para acessar o SSM e buscar todo o resto automaticamente.

### 3.4 Para ambiente de DESENVOLVIMENTO LOCAL

Duas opções:

**Opção A (recomendada):** AWS Profile no `~/.aws/credentials`:
```bash
export AWS_PROFILE=cowork-admin
npm run dev
```

**Opção B:** `.env.local` mínimo com fallback (apenas as 3 vars AWS):
```env
# .env.local — APENAS credenciais AWS para acessar SSM
# Todos os outros segredos vêm do SSM automaticamente
AWS_ACCESS_KEY_ID=<VER_SSM_ou_cowork-admin_profile>
AWS_SECRET_ACCESS_KEY=<VER_SSM_credentialsVaws-admin_secret_key>
AWS_REGION=us-east-1
```

---

## PASSO 4 — LIMPEZA TOTAL

### 4.1 Criar `.env.example` com placeholders

```env
# ============================================================
# .env.example — Apenas referência. NÃO coloque valores reais.
# Todos os segredos são gerenciados pelo AWS SSM Parameter Store.
# ============================================================

# Credenciais AWS para acessar SSM (necessário apenas em dev local)
AWS_ACCESS_KEY_ID=CHANGE_ME
AWS_SECRET_ACCESS_KEY=CHANGE_ME
AWS_REGION=us-east-1

# Variáveis não-sensíveis (podem ficar no .env)
NODE_ENV=development
PORT=3000
```

### 4.2 Atualizar `.gitignore`

Confirme que estes estão presentes:

```gitignore
# Segredos
.env
.env.local
.env.production
.env.*.local
*.pem
*.key

# AWS
.aws/
```

### 4.3 Remover `.env` do tracking do git

```bash
# Se .env foi commitado anteriormente:
git rm --cached .env .env.local .env.production 2>/dev/null
git commit -m "chore: remove .env files from tracking — migrated to AWS SSM"
```

### 4.4 Remover credenciais hardcoded do código

- Delete qualquer senha, token ou API key que esteja como string literal no código
- Substitua por chamadas ao módulo SSM (`getSSMParam(...)`)
- Remova variáveis de ambiente sensíveis dos `docker-compose.yml` locais (exceto as 3 AWS)

---

## PASSO 5 — VALIDAÇÃO FINAL

### Script de validação automatizado:

```bash
#!/bin/bash
# validate-no-secrets.sh — Verifica que não restam segredos
echo "🔒 Validando limpeza de segredos..."
ERRORS=0

# 1. Buscar padrões de credenciais
FOUND=$(grep -rn --include="*.ts" --include="*.tsx" --include="*.js" --include="*.py" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git \
  -E '(AKIA[0-9A-Z]{16}|password\s*[:=]\s*["\x27][^"\x27]{8,})' . 2>/dev/null | \
  grep -v "ssm.ts" | grep -v ".example" | grep -v "CHANGE_ME" | wc -l)
if [ "$FOUND" -gt 0 ]; then
  echo "❌ $FOUND possíveis segredos hardcoded encontrados!"
  ERRORS=$((ERRORS+1))
else
  echo "✅ Nenhum segredo hardcoded encontrado"
fi

# 2. Verificar .env não está no git
if git ls-files --error-unmatch .env 2>/dev/null; then
  echo "❌ .env ainda está no tracking do git!"
  ERRORS=$((ERRORS+1))
else
  echo "✅ .env não está no git"
fi

# 3. Verificar .gitignore
if grep -q "\.env" .gitignore 2>/dev/null; then
  echo "✅ .env no .gitignore"
else
  echo "❌ .env não está no .gitignore!"
  ERRORS=$((ERRORS+1))
fi

# 4. Verificar módulo SSM existe
if [ -f "src/lib/ssm.ts" ] || [ -f "src/config/ssm.ts" ] || [ -f "ssm_config.py" ]; then
  echo "✅ Módulo SSM encontrado"
else
  echo "❌ Módulo SSM não encontrado!"
  ERRORS=$((ERRORS+1))
fi

# 5. Verificar dependência @aws-sdk/client-ssm
if grep -q "aws-sdk/client-ssm\|boto3" package.json requirements.txt 2>/dev/null; then
  echo "✅ SDK AWS instalado"
else
  echo "❌ SDK AWS não encontrado no package.json/requirements.txt!"
  ERRORS=$((ERRORS+1))
fi

echo ""
if [ "$ERRORS" -eq 0 ]; then
  echo "🎉 VALIDAÇÃO COMPLETA — Nenhum problema encontrado!"
else
  echo "⚠️ $ERRORS problemas encontrados — corrija antes de commitar."
fi
```

### Checklist manual:

- [ ] Módulo `ssm.ts` (ou `ssm_config.py`) criado e funcional
- [ ] `@aws-sdk/client-ssm` (ou `boto3`) adicionado às dependências
- [ ] Todas as referências a `process.env.VARIAVEL_SENSIVEL` substituídas por `getSSMParam()`
- [ ] Variáveis não-sensíveis (PORT, NODE_ENV) podem continuar no `.env`
- [ ] `.env` com segredos removido do git tracking
- [ ] `.env.example` criado com placeholders
- [ ] `.gitignore` atualizado
- [ ] App inicia corretamente com SSM em dev local
- [ ] Script `validate-no-secrets.sh` passa sem erros
- [ ] Commit feito: `"feat: migrate secrets to AWS SSM Parameter Store"`

---

## PARÂMETROS QUE VOCÊ PRECISA PROVISIONAR (se ainda não existem)

Se durante a auditoria você encontrar segredos que ainda NÃO estão no SSM (ex: `DATABASE_URL`, `JWT_SECRET`, `REDIS_URL`), provisione-os:

```bash
# Template para adicionar novos parâmetros ao SSM
aws ssm put-parameter \
  --profile cowork-admin \
  --region us-east-1 \
  --name "/APP_NAME/PARAM_NAME" \
  --value "VALOR_REAL" \
  --type SecureString \
  --overwrite
```

### Convenção de nomes para novos parâmetros:

```
/{serviço}/{parâmetro}                    # Geral
/{serviço}/{app}/{parâmetro}              # Específico por app

Exemplos:
/myclinicsoft/database_url
/myclinicsoft/session_secret
/myclinicsoft/whatsapp/access_token
/myclinicsoft/whatsapp/phone_number_id
/xospam/database_url
/xospam/jwt_secret
/xospam/google/client_id
/xospam/google/client_secret
/libertakidz/database_url
/libertakidz/jwt_secret
/libertakidz/twilio/account_sid
/libertakidz/twilio/auth_token
```

**Após provisionar, atualize a tabela de inventário no dashboard do Controler (http://localhost:3001 > Credenciais > Refresh).**

---

## RESUMO DO FLUXO

```
1. Cole este prompt na sessão do app
2. Execute audit-secrets.sh
3. Monte a tabela de mapeamento (variável → parâmetro SSM)
4. Provisione no SSM os parâmetros que faltam (aws ssm put-parameter)
5. Crie src/lib/ssm.ts com o módulo acima
6. Substitua process.env.* por getSSMParam()
7. Teste: app inicia e funciona com SSM
8. Limpe: remova .env do git, crie .env.example
9. Valide: execute validate-no-secrets.sh
10. Commit: "feat: migrate secrets to AWS SSM Parameter Store"
```

---

*Gerado em 12/03/2026 pelo Controler. Dashboard de credenciais: http://localhost:3001 > Credenciais*
