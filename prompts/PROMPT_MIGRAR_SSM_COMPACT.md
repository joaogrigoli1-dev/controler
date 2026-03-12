Migre TODAS as credenciais deste app para AWS SSM Parameter Store. Siga os passos abaixo na ordem.

AWS ACESSO (profile cowork-admin, us-east-1):
  AWS_ACCESS_KEY_ID=<VER_SSM_ou_cowork-admin_profile>
  AWS_SECRET_ACCESS_KEY=<VER_SSM_credentialsVaws-admin_secret_key>
  AWS_REGION=us-east-1

PARAMETROS JA NO SSM (36 total, todos SecureString/KMS):
  /claude_api/api_key, /claude_api/project
  /cloudflare/token
  /credentials/aws-admin/access_key, /credentials/aws-admin/secret_key, /credentials/aws-admin/account_id, /credentials/aws-admin/region, /credentials/aws-admin/user
  /credentials/aws-rekognition/access_key_id, /credentials/aws-rekognition/secret_access_key, /credentials/aws-rekognition/region
  /openclaws/libertakidz/api_key, /openclaws/myclinicsoft/api_key, /openclaws/xospam/api_key
  /smtp/host (mail.libertakidz.com.br), /smtp/port (587), /smtp/mode (STARTTLS)
  /smtp/admin_user, /smtp/admin_pass, /smtp/admin_url
  /smtp/controler_email, /smtp/controler_user, /smtp/controler_pass
  /smtp/myclinicsoft_email, /smtp/myclinicsoft_user, /smtp/myclinicsoft_pass
  /smtp/xospam_email, /smtp/xospam_user, /smtp/xospam_pass
  /smtp/xospam_dev_email, /smtp/xospam_dev_user, /smtp/xospam_dev_pass
  /srv1/host (62.72.63.18), /srv1/port, /srv1/username, /srv1/password

PASSO 1 — AUDITAR: Escaneie todo o codigo buscando credenciais hardcoded em .env, process.env.*, strings com senhas, tokens, api keys, AWS keys (AKIA...). Monte uma tabela: [arquivo | variavel | valor_atual | parametro_ssm_correspondente]. Para cada segredo encontrado que NAO esta no SSM acima, provisione com: aws ssm put-parameter --profile cowork-admin --region us-east-1 --name "/{app}/{param}" --value "VALOR" --type SecureString --overwrite

PASSO 2 — CRIAR MODULO SSM: Crie src/lib/ssm.ts (Node/TS) ou ssm_config.py (Python) com: @aws-sdk/client-ssm (ou boto3), cache em memoria 5min TTL, retry com backoff, fallback para process.env em dev local. Funcoes: getSSMParam(name) e getSSMParamsByPath(path). Helper loadSMTPConfig(appName) que carrega /smtp/host, /smtp/port, /smtp/mode, /smtp/{appName}_email, /smtp/{appName}_user, /smtp/{appName}_pass em paralelo. Instale a dependencia (@aws-sdk/client-ssm ou boto3).

PASSO 3 — INTEGRAR: Substitua TODAS as referencias a process.env.VARIAVEL_SENSIVEL por chamadas getSSMParam('/path/param'). Variaveis nao-sensiveis (PORT, NODE_ENV, DATABASE_URL se nao for secret) podem continuar no .env. Na inicializacao do app, faca await das chamadas SSM antes de servir requests. Em producao (Docker/Coolify), passe APENAS AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY e AWS_REGION como env vars do container — o app busca todo o resto do SSM. Em dev local, use AWS_PROFILE=cowork-admin ou .env.local com as 3 vars AWS acima.

PASSO 4 — LIMPAR: Remova .env com segredos do git (git rm --cached .env). Crie .env.example com placeholders (CHANGE_ME). Atualize .gitignore (.env, .env.local, .env.production, .env.*.local, *.pem, *.key). Delete credenciais hardcoded do codigo.

PASSO 5 — VALIDAR: Rode grep buscando AKIA, password=, secret=, token= no codigo (excluindo node_modules, dist, ssm.ts, .example). Confirme que .env nao esta no git. Confirme que o app inicia e funciona com SSM. Commit: "feat: migrate secrets to AWS SSM Parameter Store"

CONVENCAO DE NOMES PARA NOVOS PARAMETROS: /{servico}/{parametro} ou /{servico}/{sub}/{parametro}. Exemplos: /myclinicsoft/database_url, /myclinicsoft/session_secret, /myclinicsoft/whatsapp/access_token, /xospam/database_url, /xospam/jwt_secret, /libertakidz/jwt_secret, /libertakidz/twilio/account_sid
