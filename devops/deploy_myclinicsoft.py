"""
Deploy MyClinicSoft — Local DEV → Produção (187.77.40.102)
=========================================================
Regra inviolável: caminho ÚNICO = Local → (rsync/git) → Servidor
O WhatsApp Buffer NUNCA pode ser afetado pelo deploy.

Arquitetura do novo servidor (bare-metal, sem Coolify/Docker para a app):
  - App principal: PM2 + Node.js em /app/myclinicsoft/
  - Deploy: rsync local dist/ → servidor + pm2 reload
  - PostgreSQL: banco principal 'myclinicsoft' + banco separado 'whatsapp'

DB Sync (Fase 1):
  O banco dev sobrescreve o banco de produção completamente.
  IMPORTANTE: O banco 'whatsapp' é INTEIRAMENTE SEPARADO do 'myclinicsoft'.
  O pg_dump do 'myclinicsoft' não inclui tabelas WhatsApp — elas vivem
  num banco próprio e jamais são tocadas pelo deploy sync.
"""

import os
import re
import json
import time
from datetime import datetime
from core.tools import execute_command, ssh_command
from core.database import log_execution, get_rules

LOCAL_PATH  = "/Users/jhgm/Documents/DEV/myclinicsoft"
SERVER_IP   = "187.77.40.102"
SSH_KEY     = "~/.ssh/coolify_server"
REMOTE_BASE = "/app/myclinicsoft"

# ─────────────────────────────────────────────────────────────────────────────
# Script de sincronização executado DENTRO do servidor (bare-metal).
# PostgreSQL roda diretamente no servidor (não em Docker).
# Lê DATABASE_URL do .env e restaura via psql.
# ─────────────────────────────────────────────────────────────────────────────
DB_SYNC_SCRIPT = r"""#!/bin/bash
set -eo pipefail

DUMP_FILE="/tmp/myclinicsoft_dev_dump.sql"

echo "=== MyClinicSoft DB Sync: dev -> prod ==="

# Verifica dump disponível
if [ ! -f "$DUMP_FILE" ]; then
  echo "ERROR: dump nao encontrado em $DUMP_FILE" >&2
  exit 1
fi
DUMP_SIZE=$(wc -c < "$DUMP_FILE")
echo "Dump recebido: ${DUMP_SIZE} bytes"

# Descobre DATABASE_URL do .env
ENV_FILE=""
if [ -f "/app/myclinicsoft/.env" ]; then
  ENV_FILE="/app/myclinicsoft/.env"
fi

if [ -z "$ENV_FILE" ]; then
  echo "ERROR: .env nao encontrado em /app/myclinicsoft/" >&2
  exit 1
fi

DATABASE_URL=$(grep "^DATABASE_URL=" "$ENV_FILE" | cut -d'=' -f2- | tr -d '"' | tr -d "'")
if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: DATABASE_URL nao encontrada no .env ($ENV_FILE)" >&2
  exit 1
fi
echo "Prod DB: $(echo "$DATABASE_URL" | sed 's|://[^:]*:[^@]*@|://*****@|')"

# Extrai componentes da URL
# Ex: postgresql://user:pass@localhost:5432/myclinicsoft
PSQL_USER=$(echo "$DATABASE_URL" | sed -E 's|.*://([^:]+):.*|\1|')
PSQL_PASS=$(echo "$DATABASE_URL" | sed -E 's|.*://[^:]+:([^@]+)@.*|\1|')
PSQL_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:]+):.*|\1|')
PSQL_PORT=$(echo "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
PSQL_DB=$(echo   "$DATABASE_URL" | sed -E 's|.*/([^?]+).*|\1|')
PSQL_PORT=${PSQL_PORT:-5432}

echo "DB: host=$PSQL_HOST port=$PSQL_PORT db=$PSQL_DB user=$PSQL_USER"

# Restaura — psql direto (bare-metal, sem docker)
echo "[1/1] Restaurando banco dev em producao..."
RESTORE_ERRORS=$(
  PGPASSWORD="$PSQL_PASS" psql \
    -U "$PSQL_USER" -h "$PSQL_HOST" -p "$PSQL_PORT" -d "$PSQL_DB" \
    -f "$DUMP_FILE" 2>&1 \
  | grep -cE "^ERROR" || true
)
echo "      Erros SQL: ${RESTORE_ERRORS:-0}"

# Limpeza
rm -f "$DUMP_FILE"
echo "=== SYNC_OK ==="
"""

# ─────────────────────────────────────────────────────────────────────────────
# Script de deploy rsync + PM2 executado DENTRO do servidor.
# Faz gestão de releases com symlink + pm2 reload.
# ─────────────────────────────────────────────────────────────────────────────
DEPLOY_SCRIPT = r"""#!/bin/bash
set -eo pipefail

APP_DIR="/app/myclinicsoft"

echo "=== MyClinicSoft Deploy: PM2 ==="
echo "App dir: $APP_DIR"

cd "$APP_DIR"

# Instala deps só se package-lock mudou
LOCK_BACKUP="/tmp/myclinicsoft_prev_lock.json"
LOCK_CHANGED=true

if [ -f "$LOCK_BACKUP" ] && [ -f "$APP_DIR/package-lock.json" ]; then
  if diff -q "$APP_DIR/package-lock.json" "$LOCK_BACKUP" &>/dev/null; then
    LOCK_CHANGED=false
  fi
fi

if [ "$LOCK_CHANGED" = true ]; then
  echo "  package-lock.json mudou — npm install..."
  # Remove lock do Mac (ARM64) — incompatível com servidor x64.
  # --force: ignora incompatibilidade de plataforma (arm64 vs x64)
  rm -f "$APP_DIR/package-lock.json"
  npm install --omit=dev --ignore-scripts --no-audit --no-fund --force 2>&1 | tail -10
  echo "  npm install concluido"
  # Salva lock gerado pelo servidor para comparação futura
  cp -f "$APP_DIR/package-lock.json" "$LOCK_BACKUP" 2>/dev/null || true
else
  echo "  package-lock.json inalterado — deps ok"
fi

# PM2: reload (zero-downtime) ou start se não existir
if pm2 describe myclinicsoft &>/dev/null; then
  pm2 reload myclinicsoft --update-env
  echo "  PM2: reloaded"
else
  pm2 start "$APP_DIR/dist/index.cjs" --name myclinicsoft
  echo "  PM2: started"
fi

echo "=== DEPLOY_OK ==="
"""


# ─────────────────────────────────────────────────────────────────────────────
# Funções auxiliares
# ─────────────────────────────────────────────────────────────────────────────

def _check_ssh():
    """Testa se a conexão SSH está funcional."""
    r = ssh_command("echo ok", timeout=15)
    return r["success"] and "ok" in r.get("stdout", "")


def _check_buffer_health():
    """
    Verifica se o WhatsApp Buffer está UP no servidor.
    Tenta múltiplos métodos (do mais confiável ao fallback):
      1. curl na porta 3001 (qualquer resposta = UP)
      2. docker ps filtrando container do buffer (buffer ainda usa Docker)
      3. netstat/ss verificando porta 3001 em LISTEN
    """
    # Método 1: curl simples na porta 3001 (aceita qualquer resposta HTTP)
    r = ssh_command("curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/ --max-time 5", timeout=15)
    if r["success"]:
        code = r.get("stdout", "").strip().strip("'")
        if code and code != "000":
            return {"up": True, "method": "http", "detail": f"HTTP {code}"}

    # Método 2: verificar container Docker do buffer (o buffer ainda pode rodar em Docker)
    r = ssh_command("docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i buffer", timeout=15)
    if r["success"] and r.get("stdout", "").strip():
        return {"up": True, "method": "docker", "detail": r["stdout"].strip()}

    # Método 3: verificar porta 3001 em LISTEN
    r = ssh_command("ss -tlnp 2>/dev/null | grep ':3001 ' || netstat -tlnp 2>/dev/null | grep ':3001 '", timeout=15)
    if r["success"] and r.get("stdout", "").strip():
        return {"up": True, "method": "port", "detail": "Porta 3001 em LISTEN"}

    return {"up": False, "method": "all_failed", "detail": "Nenhum método detectou o buffer ativo"}


def _get_local_db_url():
    """Lê DATABASE_URL do .env local do projeto."""
    env_file = os.path.join(LOCAL_PATH, ".env")
    try:
        with open(env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith("DATABASE_URL=") and not line.startswith("#"):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None


def _find_pg_dump():
    """Localiza o executável pg_dump no Mac (Homebrew arm64 ou intel)."""
    candidates = [
        "pg_dump",                          # já no PATH
        "/opt/homebrew/bin/pg_dump",        # Homebrew Apple Silicon
        "/usr/local/bin/pg_dump",           # Homebrew Intel
        "/opt/homebrew/opt/postgresql@16/bin/pg_dump",
        "/opt/homebrew/opt/postgresql@15/bin/pg_dump",
        "/opt/homebrew/opt/postgresql@14/bin/pg_dump",
    ]
    for c in candidates:
        r = execute_command(f'test -x "$(which {c} 2>/dev/null || echo {c})" && echo OK || {c} --version 2>/dev/null | head -1')
        if r["success"] or "pg_dump" in r.get("stdout", ""):
            return c
    # fallback: tenta achar via mdfind (Spotlight)
    r = execute_command("mdfind -name pg_dump 2>/dev/null | grep bin | head -1")
    found = r.get("stdout", "").strip()
    if found:
        return found
    return "pg_dump"


def _sync_database_dev_to_prod(log):
    """
    Sincroniza banco 'myclinicsoft' dev (Mac local) → prod (servidor bare-metal).

    Fase 1: dev é fonte única da verdade para todos os dados.

    Nota sobre banco WhatsApp:
    O banco 'whatsapp' (tabelas conversations, messages, etc.) é SEPARADO do
    'myclinicsoft'. O pg_dump abaixo só captura 'myclinicsoft' — as tabelas
    WhatsApp não existem nesse banco e NUNCA são afetadas.
    """
    DUMP_LOCAL    = "/tmp/myclinicsoft_dev_dump.sql"
    DUMP_REMOTE   = "/tmp/myclinicsoft_dev_dump.sql"
    SCRIPT_LOCAL  = "/tmp/myclinicsoft_db_sync.sh"
    SCRIPT_REMOTE = "/tmp/myclinicsoft_db_sync.sh"

    # ── Localiza pg_dump ──
    pg_dump_bin = _find_pg_dump()

    # ── Obtém URL do banco local ──
    local_db_url = _get_local_db_url()
    if not local_db_url:
        log("db-sync", "error", "DATABASE_URL não encontrada no .env local do projeto")
        return False

    # ── Passo 1: pg_dump do banco dev local ──
    # Não precisa mais excluir tabelas WhatsApp — elas estão no banco 'whatsapp' separado.
    log("db-dump", "running", f"pg_dump banco dev local (myclinicsoft)... ({pg_dump_bin})")
    r = execute_command(
        f'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" '
        f'{pg_dump_bin} "{local_db_url}" --clean --if-exists --no-owner --no-acl '
        f'> {DUMP_LOCAL} 2>/tmp/pgdump_err.txt',
        timeout=120
    )
    if not r["success"] or not os.path.exists(DUMP_LOCAL) or os.path.getsize(DUMP_LOCAL) < 1000:
        err = ""
        try:
            with open("/tmp/pgdump_err.txt") as f:
                err = f.read()[-400:]
        except Exception:
            err = r.get("stderr") or r.get("stdout", "")
        log("db-dump", "error", f"pg_dump falhou:\n{err or 'sem saída — verifique se pg_dump está instalado'}")
        return False

    dump_size_kb = os.path.getsize(DUMP_LOCAL) // 1024
    log("db-dump", "ok", f"Dump gerado: {dump_size_kb} KB")

    # ── Passo 2: SCP dump → servidor ──
    log("db-transfer", "running", f"Transferindo dump ({dump_size_kb} KB) → servidor...")
    r = execute_command(
        f'scp -i {SSH_KEY} -o StrictHostKeyChecking=no '
        f'{DUMP_LOCAL} root@{SERVER_IP}:{DUMP_REMOTE}',
        timeout=120
    )
    if not r["success"]:
        log("db-transfer", "error",
            f"SCP falhou: {r.get('stderr') or r.get('stdout', '')[:300]}")
        execute_command(f'rm -f {DUMP_LOCAL}')
        return False
    log("db-transfer", "ok", "Dump transferido")

    # ── Passo 3: Envia script de sync ──
    log("db-script", "running", "Enviando script de sync para o servidor...")
    try:
        with open(SCRIPT_LOCAL, "w") as f:
            f.write(DB_SYNC_SCRIPT)
    except Exception as e:
        log("db-script", "error", f"Falha ao criar script: {e}")
        execute_command(f'rm -f {DUMP_LOCAL}')
        return False

    r = execute_command(
        f'scp -i {SSH_KEY} -o StrictHostKeyChecking=no '
        f'{SCRIPT_LOCAL} root@{SERVER_IP}:{SCRIPT_REMOTE}',
        timeout=30
    )
    if not r["success"]:
        log("db-script", "error", f"SCP script falhou: {r.get('stderr', '')[:200]}")
        execute_command(f'rm -f {DUMP_LOCAL} {SCRIPT_LOCAL}')
        return False
    log("db-script", "ok", "Script enviado")

    # ── Passo 4: Executa script no servidor (psql direto, sem Docker) ──
    log("db-restore", "running", "Servidor: restaurando banco myclinicsoft (psql direto)...")
    r = ssh_command(f'bash {SCRIPT_REMOTE} 2>&1', timeout=300)
    output = (r.get("stdout", "") + r.get("stderr", "")).strip()

    # Limpeza local
    execute_command(f'rm -f {DUMP_LOCAL} {SCRIPT_LOCAL}')
    ssh_command(f'rm -f {SCRIPT_REMOTE} 2>/dev/null || true')

    if not r["success"] or "SYNC_OK" not in output:
        error_lines = [l for l in output.split('\n') if 'ERROR' in l or 'error' in l.lower()]
        detail = '\n'.join(error_lines[:5]) if error_lines else output[-400:]
        log("db-restore", "error", f"Sync falhou no servidor:\n{detail or '(sem saída)'}")
        return False

    summary = '\n'.join(l for l in output.split('\n') if l.strip())
    log("db-restore", "ok",
        f"✓ Banco sincronizado: dev → prod | Banco whatsapp preservado (separado)\n{summary}")
    return True


def _deploy_rsync_pm2(log):
    """
    Faz o deploy do código para o servidor via rsync + PM2.
    Estratégia: rsync dist/ + package.json → /app/myclinicsoft/ + pm2 reload.
    """
    APP_DIR         = f"{REMOTE_BASE}"
    SCRIPT_LOCAL    = "/tmp/myclinicsoft_deploy.sh"
    SCRIPT_REMOTE   = "/tmp/myclinicsoft_deploy.sh"

    # ── Passo 1: rsync dist/ + package files para o servidor ──
    log("rsync", "running", f"rsync dist/ → {SERVER_IP}:{APP_DIR}/...")
    r = execute_command(
        f'rsync -az --delete '
        f'-e "ssh -i {SSH_KEY} -o StrictHostKeyChecking=no" '
        f'{LOCAL_PATH}/dist/ '
        f'root@{SERVER_IP}:{APP_DIR}/dist/',
        cwd=LOCAL_PATH,
        timeout=120
    )
    if not r["success"]:
        log("rsync", "error", f"rsync dist/ falhou: {r.get('stderr') or r.get('stdout', '')[:300]}")
        return False

    # rsync package.json + package-lock.json separadamente
    r2 = execute_command(
        f'scp -i {SSH_KEY} -o StrictHostKeyChecking=no '
        f'{LOCAL_PATH}/package.json {LOCAL_PATH}/package-lock.json '
        f'root@{SERVER_IP}:{APP_DIR}/',
        timeout=30
    )
    if not r2["success"]:
        log("rsync", "error", f"scp package files falhou: {r2.get('stderr', '')[:200]}")
        return False

    # Calcula tamanho do dist/
    size_r = execute_command(f'du -sh {LOCAL_PATH}/dist/')
    size_str = size_r.get("stdout", "").split()[0] if size_r["success"] else "?"
    log("rsync", "ok", f"Arquivos sincronizados ({size_str})")

    # ── Passo 2: Envia script de deploy ──
    log("pm2-deploy", "running", "Enviando script de PM2 deploy...")
    try:
        with open(SCRIPT_LOCAL, "w") as f:
            f.write(DEPLOY_SCRIPT)
    except Exception as e:
        log("pm2-deploy", "error", f"Falha ao criar script: {e}")
        return False

    r = execute_command(
        f'scp -i {SSH_KEY} -o StrictHostKeyChecking=no '
        f'{SCRIPT_LOCAL} root@{SERVER_IP}:{SCRIPT_REMOTE}',
        timeout=30
    )
    if not r["success"]:
        log("pm2-deploy", "error", f"SCP script falhou: {r.get('stderr', '')[:200]}")
        execute_command(f'rm -f {SCRIPT_LOCAL}')
        return False

    # ── Passo 3: Executa deploy no servidor ──
    log("pm2-deploy", "running", "Servidor: npm ci (se necessário) + pm2 reload...")
    r = ssh_command(f'bash {SCRIPT_REMOTE} 2>&1', timeout=180)
    output = (r.get("stdout", "") + r.get("stderr", "")).strip()

    # Limpeza
    execute_command(f'rm -f {SCRIPT_LOCAL}')
    ssh_command(f'rm -f {SCRIPT_REMOTE} 2>/dev/null || true')

    if not r["success"] or "DEPLOY_OK" not in output:
        error_lines = [l for l in output.split('\n') if 'ERROR' in l.upper() or 'failed' in l.lower()]
        detail = '\n'.join(error_lines[:5]) if error_lines else output[-400:]
        log("pm2-deploy", "error", f"Deploy PM2 falhou:\n{detail or '(sem saída)'}")
        return False

    summary = '\n'.join(l for l in output.split('\n') if l.strip())
    log("pm2-deploy", "ok", f"✓ Deploy PM2 concluído\n{summary}")
    return True


# ─────────────────────────────────────────────────────────────────────────────
# Sync Leads: prod → local
# ─────────────────────────────────────────────────────────────────────────────

# Tabelas de leads a sincronizar (ordem respeita FKs: partners antes de leads)
_LEADS_TABLES = ["partners", "leads", "lead_interactions"]

def _parse_db_url(url: str):
    """Extrai componentes de uma DATABASE_URL postgresql://user:pass@host:port/db."""
    m = re.match(r'postgresql(?:\+\w+)?://([^:]+):([^@]+)@([^:/]+):?(\d+)?/([^?]+)', url)
    if not m:
        return None
    user, password, host, port, dbname = m.groups()
    return {"user": user, "password": password, "host": host,
            "port": port or "5432", "dbname": dbname}


async def sync_leads_from_prod(log_callback=None):
    """
    Puxa novos leads/interações do servidor de produção para o banco local.

    Fluxo:
      1. Verifica SSH
      2. Lê DATABASE_URL do servidor (.env do app)
      3. pg_dump --data-only --column-inserts das tabelas de leads
      4. SCP dump → local
      5. Adiciona ON CONFLICT (id) DO NOTHING em cada INSERT
      6. Aplica no banco local via psql
    """
    logs = []
    started = datetime.now()

    def log(step, status, msg):
        entry = {"step": step, "status": status, "message": msg,
                 "timestamp": datetime.now().isoformat()}
        logs.append(entry)
        if log_callback:
            log_callback(entry)

    DUMP_REMOTE = "/tmp/leads_prod_dump.sql"
    DUMP_LOCAL  = "/tmp/leads_prod_dump.sql"
    DUMP_PATCHED = "/tmp/leads_prod_dump_patched.sql"

    # ── 0: SSH ──
    log("ssh", "running", f"Conectando ao servidor {SERVER_IP}...")
    r = ssh_command("echo ok", timeout=15)
    if not r.get("success"):
        log("ssh", "error", f"Sem acesso SSH ao servidor {SERVER_IP}")
        return {"success": False, "logs": logs}
    log("ssh", "ok", "SSH OK")

    # ── 1: Lê DATABASE_URL do servidor ──
    log("db-url", "running", "Lendo DATABASE_URL do servidor...")
    r = ssh_command(
        "grep '^DATABASE_URL=' /app/myclinicsoft/.env | cut -d'=' -f2- | tr -d '\"' | tr -d \"'\"",
        timeout=15
    )
    prod_url = r.get("stdout", "").strip()
    if not prod_url:
        log("db-url", "error", "DATABASE_URL não encontrada em /app/myclinicsoft/.env")
        return {"success": False, "logs": logs}
    creds = _parse_db_url(prod_url)
    if not creds:
        log("db-url", "error", f"Formato de DATABASE_URL inesperado: {prod_url[:40]}...")
        return {"success": False, "logs": logs}
    masked = prod_url.replace(creds["password"], "****")
    log("db-url", "ok", f"Banco prod: {masked}")

    # ── 2: pg_dump no servidor ──
    tables_arg = " ".join(f"--table={t}" for t in _LEADS_TABLES)
    pg_env = f'PGPASSWORD="{creds["password"]}"'
    pg_conn = f'-U {creds["user"]} -h {creds["host"]} -p {creds["port"]} -d {creds["dbname"]}'
    dump_cmd = (
        f'{pg_env} pg_dump {pg_conn} '
        f'--data-only --column-inserts {tables_arg} '
        f'> {DUMP_REMOTE} 2>/tmp/leads_dump_err.txt && echo "DUMP_OK"'
    )
    log("pg-dump", "running", f"Dump das tabelas {', '.join(_LEADS_TABLES)} no servidor...")
    r = ssh_command(dump_cmd, timeout=180)
    stdout = r.get("stdout", "")
    if not r.get("success") or "DUMP_OK" not in stdout:
        err_r = ssh_command("cat /tmp/leads_dump_err.txt 2>/dev/null | tail -10", timeout=10)
        log("pg-dump", "error", f"pg_dump falhou:\n{err_r.get('stdout', '')[:400]}")
        return {"success": False, "logs": logs}

    size_r = ssh_command(
        f"stat -c%s {DUMP_REMOTE} 2>/dev/null || stat -f%z {DUMP_REMOTE} 2>/dev/null || echo 0",
        timeout=10
    )
    size_kb = int(re.sub(r'[^\d]', '', size_r.get("stdout", "0").strip() or "0") or "0") // 1024
    log("pg-dump", "ok", f"Dump gerado: {size_kb} KB")

    # ── 3: SCP → local ──
    log("scp", "running", "Transferindo dump para local...")
    r = execute_command(
        f'scp -i {SSH_KEY} -o StrictHostKeyChecking=no '
        f'root@{SERVER_IP}:{DUMP_REMOTE} {DUMP_LOCAL}',
        timeout=180
    )
    if not r["success"]:
        log("scp", "error", f"SCP falhou: {(r.get('stderr') or r.get('stdout', ''))[:300]}")
        return {"success": False, "logs": logs}
    log("scp", "ok", "Dump transferido")

    # ── 4: Patch INSERT → ON CONFLICT (id) DO NOTHING ──
    log("patch", "running", "Aplicando ON CONFLICT (id) DO NOTHING nas inserções...")
    r = execute_command(
        f"sed \"s/^INSERT INTO \\([^ ]*\\) (\\(.*\\)) VALUES (\\(.*\\));$/INSERT INTO \\1 (\\2) VALUES (\\3) ON CONFLICT (id) DO NOTHING;/\" "
        f"{DUMP_LOCAL} > {DUMP_PATCHED}",
        timeout=30
    )
    if not r["success"] or not os.path.exists(DUMP_PATCHED):
        log("patch", "error", "Falha ao processar dump")
        execute_command(f"rm -f {DUMP_LOCAL} {DUMP_PATCHED}")
        return {"success": False, "logs": logs}
    log("patch", "ok", "Dump processado")

    # ── 5: Aplica no banco local ──
    local_db_url = _get_local_db_url()
    if not local_db_url:
        log("import", "error", "DATABASE_URL local não encontrada")
        execute_command(f"rm -f {DUMP_LOCAL} {DUMP_PATCHED}")
        return {"success": False, "logs": logs}

    log("import", "running", "Importando no banco local (ON CONFLICT → ignora duplicatas)...")
    r = execute_command(
        f'psql "{local_db_url}" --set ON_ERROR_STOP=off -f {DUMP_PATCHED} 2>&1 | tail -5',
        timeout=180
    )
    output = (r.get("stdout", "") + r.get("stderr", "")).strip()

    # Limpa arquivos temporários
    execute_command(f"rm -f {DUMP_LOCAL} {DUMP_PATCHED}")
    ssh_command(f"rm -f {DUMP_REMOTE} /tmp/leads_dump_err.txt 2>/dev/null || true")

    if not r.get("success"):
        log("import", "error", f"Import falhou:\n{output[:400]}")
        return {"success": False, "logs": logs}

    # Conta leads novos importados
    local_creds = _parse_db_url(local_db_url)
    count_r = execute_command(
        f'psql "{local_db_url}" -t -A -c "SELECT COUNT(*) FROM leads"',
        timeout=15
    )
    total_local = count_r.get("stdout", "?").strip()

    log("import", "ok",
        f"✓ Leads sincronizados de prod → local\n"
        f"  Total no banco local agora: {total_local} leads\n"
        f"  (Duplicatas ignoradas automaticamente)\n"
        f"  {output or 'OK'}")

    elapsed = (datetime.now() - started).total_seconds()
    success = all(l["status"] != "error" for l in logs)
    log("done", "ok" if success else "error",
        f"{'✓ Sync concluído' if success else '✗ Sync com problemas'} em {elapsed:.0f}s")

    log_execution("myclinicsoft", "leads_sync", "success" if success else "failed", logs, elapsed)
    return {"success": success, "logs": logs, "elapsed_seconds": elapsed}


# ─────────────────────────────────────────────────────────────────────────────
# Pipeline principal de deploy
# ─────────────────────────────────────────────────────────────────────────────

async def deploy(log_callback=None):
    """
    Executa o deploy completo do MyClinicSoft.
    log_callback(entry) — para atualizar interface em tempo real.

    Sequência (novo servidor bare-metal + PM2):
      0. SSH check
      1. Buffer check (pré-deploy) — cancela se offline
      2. TypeScript check           — cancela se erros
      3. Build local                — cancela se falhar
      4. DB Sync dev → prod         — cancela se falhar (Fase 1)
      5. Git push → main            — para versionamento
      6. rsync dist/ + pm2 reload   — deploy sem Coolify
      7. Health check app
      8. Health check buffer (pós-deploy)
    """
    logs = []
    started = datetime.now()

    def log(step, status, msg):
        entry = {"step": step, "status": status, "message": msg, "time": datetime.now().isoformat()}
        logs.append(entry)
        if log_callback:
            log_callback(entry)

    # ── PRÉ-CHECK 0: Conexão SSH ──
    log("ssh", "running", f"Testando conexão SSH com servidor {SERVER_IP}...")
    if not _check_ssh():
        log("ssh", "error",
            f"Sem acesso SSH ao servidor {SERVER_IP}. "
            "Verifique: 1) chave SSH existe  "
            "2) servidor acessível  3) permissões da chave (chmod 600)")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "SSH inacessível"}
    log("ssh", "ok", f"SSH OK → {SERVER_IP}")

    # ── PRÉ-CHECK 1: Buffer deve estar UP ──
    log("pre-check", "running", "Verificando WhatsApp Buffer...")
    buf = _check_buffer_health()
    if not buf["up"]:
        log("pre-check", "error",
            f"WhatsApp Buffer OFFLINE! Deploy CANCELADO por segurança. "
            f"Detalhe: {buf['detail']}")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Buffer offline"}
    log("pre-check", "ok", f"Buffer UP — verificado via {buf['method']} ({buf['detail']})")

    # ── 1: TypeScript check ──
    log("check", "running", "npm run check...")
    r = execute_command("npm run check", cwd=LOCAL_PATH, timeout=60)
    if not r["success"]:
        log("check", "error", f"TypeScript com erros:\n{r['stderr'] or r['stdout']}")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "TypeScript check falhou"}
    log("check", "ok", "0 erros TypeScript")

    # ── 2: Build ──
    log("build", "running", "npm run build...")
    r = execute_command("npm run build", cwd=LOCAL_PATH, timeout=180)
    if not r["success"]:
        log("build", "error", f"Build falhou:\n{r['stderr'] or r['stdout']}")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Build falhou"}
    log("build", "ok", "Build OK")

    # ── 3: DB Sync dev → prod (Fase 1 — dev é fonte única da verdade) ──
    log("db-sync", "running", "Iniciando DB sync: myclinicsoft dev → prod...")
    sync_ok = _sync_database_dev_to_prod(log)
    if not sync_ok:
        log("db-sync", "error",
            "DB sync falhou — deploy cancelado para proteger integridade do banco de produção")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "DB sync falhou"}

    # ── 4: Git push → main (versionamento) ──
    log("git", "running", "Git push main...")
    r = execute_command("git status --porcelain", cwd=LOCAL_PATH)
    if r["stdout"].strip():
        ts = datetime.now().strftime("%Y%m%d-%H%M%S")
        execute_command(f'git add -A && git commit -m "deploy: {ts}"', cwd=LOCAL_PATH)
        r = execute_command("git push origin main", cwd=LOCAL_PATH, timeout=60)
        log("git", "ok" if r["success"] else "warning",
            "Push OK" if r["success"] else f"Push falhou (deploy continua via rsync)")
    else:
        execute_command("git push origin main", cwd=LOCAL_PATH, timeout=60)
        log("git", "ok", "Sem alterações para commitar — push feito")

    # ── 5: Deploy via rsync + PM2 (substituiu Coolify) ──
    log("deploy", "running", "Deploy: rsync dist/ + PM2 reload...")
    deploy_ok = _deploy_rsync_pm2(log)
    if not deploy_ok:
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Deploy rsync/PM2 falhou"}

    # ── 6: Health check app ──
    import time
    log("health-app", "running", "Health check da app...")
    MAX_WAIT = 60   # 1 minuto para PM2 subir
    INTERVAL = 10
    elapsed_w = 0
    app_ok = False
    code = "000"

    while elapsed_w < MAX_WAIT:
        r = ssh_command(
            "curl -sf -o /dev/null -w '%{http_code}' http://localhost:5000/api/health --max-time 8",
            timeout=15
        )
        code = r.get("stdout", "").strip().strip("'")
        if r["success"] and code == "200":
            app_ok = True
            break
        time.sleep(INTERVAL)
        elapsed_w += INTERVAL
        log("health-app", "running", f"Aguardando app subir... {elapsed_w}s/{MAX_WAIT}s (HTTP {code or '?'})")

    log("health-app", "ok" if app_ok else "error",
        f"App UP (HTTP {code})" if app_ok
        else f"App não respondeu após {MAX_WAIT}s (HTTP {code or '?'}) — verifique PM2: pm2 logs myclinicsoft")

    # ── 7: Health check buffer pós-deploy ──
    log("health-buffer", "running", "Health check buffer pós-deploy...")
    buf = _check_buffer_health()
    log("health-buffer", "ok" if buf["up"] else "error",
        f"Buffer continua UP ({buf['detail']})" if buf["up"] else
        f"ALERTA CRÍTICO: Buffer caiu após deploy! {buf['detail']} — Agir imediatamente!")

    elapsed = (datetime.now() - started).total_seconds()
    success = all(l["status"] != "error" for l in logs)
    log("done", "ok" if success else "error",
        f"{'✓ Deploy concluído' if success else '✗ Deploy com problemas'} em {elapsed:.0f}s")

    log_execution("myclinicsoft", "deploy", "success" if success else "failed", logs, elapsed)
    return {"success": success, "logs": logs, "elapsed_seconds": elapsed}
