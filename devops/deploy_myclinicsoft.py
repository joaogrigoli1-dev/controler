"""
Deploy MyClinicSoft — Workflow Profissional
============================================
Fluxo: develop (dev) → PR → main (GitHub) → deploy (prod)

Regras do workflow profissional:
  1. Desenvolvimento acontece na branch 'develop'
  2. Deploy para produção SOMENTE via merge da 'develop' na 'main'
  3. O deploy lê a branch 'main' e envia para produção
  4. Rollback automático se health check falhar
  5. Banco de dados: migrations via Drizzle (nunca sync dev→prod)
  6. WhatsApp Buffer NUNCA pode ser afetado pelo deploy

Servidores:
  - srv2 (prod): 187.77.40.102 — myclinicsoft produção (PM2 + PostgreSQL)
  - srv1 (dev):  62.72.63.18   — projetos SaaS novos (Coolify)
  - Mac local:   desenvolvimento

Arquitetura de deploy (atomic releases):
  /app/myclinicsoft/
    ├── releases/
    │   ├── 20260304-191500/
    │   └── 20260304-193000/  ← release atual
    ├── current → releases/20260304-193000  (symlink)
    └── shared/
        ├── .env
        ├── uploads/
        └── .storage/

  NOTA: Na migração inicial, o conteúdo flat existente em /app/myclinicsoft
  será reorganizado automaticamente para a estrutura de atomic releases.
"""

import os
import re
import json
import time
from datetime import datetime
from core.tools import execute_command, ssh_command
from core.database import log_execution, get_rules

# ─── Configuração ────────────────────────────────────────────────────────────

LOCAL_PATH  = "/Users/jhgm/Documents/DEV/myclinicsoft"
SERVER_IP   = "187.77.40.102"
SSH_KEY     = "~/.ssh/prod_server"
REMOTE_BASE = "/app/myclinicsoft"
GITHUB_REPO = "joaogrigoli1-dev/myclinicsoft"
HEALTH_URL  = "http://localhost:5000/api/health"
MAX_RELEASES = 5

# ─── Deploy Script (executado no servidor) ───────────────────────────────────

REMOTE_DEPLOY_SCRIPT = r"""#!/bin/bash
set -eo pipefail

RELEASE_DIR="$1"
SHARED_DIR="$2"
CURRENT_LINK="$3"
REMOTE_BASE="$4"
MAX_RELEASES="$5"

echo "=== MyClinicSoft Deploy: Atomic Release ==="
echo "Release: $RELEASE_DIR"

# Symlink shared resources
ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/.env"
ln -sfn "$SHARED_DIR/uploads" "$RELEASE_DIR/uploads" 2>/dev/null || true
ln -sfn "$SHARED_DIR/.storage" "$RELEASE_DIR/.storage" 2>/dev/null || true
echo "  Shared resources linked"

# Install dependencies
PREV_RELEASE=$(readlink -f "$CURRENT_LINK" 2>/dev/null || echo "")
LOCK_CHANGED=true

if [ -n "$PREV_RELEASE" ] && [ -f "$PREV_RELEASE/package-lock.json" ]; then
  if diff -q "$RELEASE_DIR/package-lock.json" "$PREV_RELEASE/package-lock.json" &>/dev/null; then
    LOCK_CHANGED=false
  fi
fi

if [ "$LOCK_CHANGED" = true ]; then
  echo "  package-lock.json changed — npm ci..."
  cd "$RELEASE_DIR"
  npm ci --omit=dev --ignore-scripts 2>&1 | tail -5
else
  echo "  package-lock.json unchanged — copying node_modules..."
  cp -al "$PREV_RELEASE/node_modules" "$RELEASE_DIR/node_modules" 2>/dev/null || {
    echo "  cp -al failed, falling back to npm ci..."
    cd "$RELEASE_DIR"
    npm ci --omit=dev --ignore-scripts 2>&1 | tail -5
  }
fi

# Atomic symlink switch
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.tmp"
mv -fT "${CURRENT_LINK}.tmp" "$CURRENT_LINK"
echo "  Symlink: current -> $RELEASE_DIR"

# PM2 reload (zero-downtime)
if pm2 describe myclinicsoft &>/dev/null; then
  pm2 reload myclinicsoft --update-env
  echo "  PM2: reloaded"
else
  cd "$REMOTE_BASE"
  pm2 start "$CURRENT_LINK/dist/index.cjs" --name myclinicsoft
  echo "  PM2: started"
fi

# Cleanup old releases
cd "$REMOTE_BASE/releases"
RELEASES=($(ls -1d */ 2>/dev/null | sort))
TOTAL=${#RELEASES[@]}
if [ "$TOTAL" -gt "$MAX_RELEASES" ]; then
  TO_DELETE=$((TOTAL - MAX_RELEASES))
  for ((i=0; i<TO_DELETE; i++)); do
    echo "  Removing old release: ${RELEASES[$i]}"
    rm -rf "${RELEASES[$i]}"
  done
fi

echo "=== DEPLOY_OK ==="
"""

REMOTE_ROLLBACK_SCRIPT = r"""#!/bin/bash
set -eo pipefail

CURRENT_LINK="$1"
REMOTE_BASE="$2"

echo "=== ROLLBACK ==="
RELEASES=($(ls -1d "$REMOTE_BASE/releases"/*/ 2>/dev/null | sort))
TOTAL=${#RELEASES[@]}

if [ "$TOTAL" -lt 2 ]; then
  echo "ERROR: No previous release to rollback to"
  exit 1
fi

PREV="${RELEASES[$((TOTAL-2))]}"
PREV_DIR="${PREV%/}"
ln -sfn "$PREV_DIR" "${CURRENT_LINK}.tmp"
mv -fT "${CURRENT_LINK}.tmp" "$CURRENT_LINK"
pm2 reload myclinicsoft --update-env
echo "Rolled back to: $(basename $PREV_DIR)"
echo "=== ROLLBACK_OK ==="
"""


# ─── Funções auxiliares ──────────────────────────────────────────────────────

def _ssh(cmd, timeout=30):
    """Executa comando SSH no servidor de produção."""
    return ssh_command(cmd, host=SERVER_IP, key=SSH_KEY, timeout=timeout)


def _check_ssh():
    """Testa se a conexão SSH está funcional."""
    r = _ssh("echo ok", timeout=15)
    return r["success"] and "ok" in r.get("stdout", "")


def _ensure_atomic_structure(log):
    """
    Garante que a estrutura de atomic releases existe no servidor.
    Se o servidor ainda usa a estrutura flat (sem releases/), faz a migração:
      1. Cria releases/ e shared/
      2. Move .env para shared/
      3. Move .storage e uploads para shared/
      4. Não toca nos arquivos da app (serão recriados no deploy)
    """
    r = _ssh(f"test -d {REMOTE_BASE}/releases && echo EXISTS || echo MISSING", timeout=10)
    if "EXISTS" in r.get("stdout", ""):
        log("structure", "ok", "Estrutura de atomic releases já existe")
        return True

    log("structure", "running", "Migrando para atomic releases...")

    # Cria diretórios
    _ssh(f"mkdir -p {REMOTE_BASE}/releases {REMOTE_BASE}/shared", timeout=10)

    # Move .env para shared (se existir na raiz e não existir em shared)
    _ssh(
        f'test -f {REMOTE_BASE}/.env && ! test -f {REMOTE_BASE}/shared/.env && '
        f'cp {REMOTE_BASE}/.env {REMOTE_BASE}/shared/.env || true',
        timeout=10
    )

    # Move .storage para shared (se existir na raiz)
    _ssh(
        f'test -d {REMOTE_BASE}/.storage && ! test -d {REMOTE_BASE}/shared/.storage && '
        f'mv {REMOTE_BASE}/.storage {REMOTE_BASE}/shared/.storage || true',
        timeout=15
    )

    # Move uploads para shared (se existir na raiz)
    _ssh(
        f'test -d {REMOTE_BASE}/uploads && ! test -d {REMOTE_BASE}/shared/uploads && '
        f'mv {REMOTE_BASE}/uploads {REMOTE_BASE}/shared/uploads || true',
        timeout=15
    )

    # Atualiza ecosystem.config.js para usar current/ (symlink)
    _ssh(
        f"sed -i \"s|{REMOTE_BASE}/dist/index.cjs|{REMOTE_BASE}/current/dist/index.cjs|g\" "
        f"/app/ecosystem.config.js 2>/dev/null || true",
        timeout=10
    )
    _ssh(
        f"sed -i \"s|cwd: '{REMOTE_BASE}'|cwd: '{REMOTE_BASE}/current'|\" "
        f"/app/ecosystem.config.js 2>/dev/null || true",
        timeout=10
    )

    # Verifica
    r = _ssh(f"test -d {REMOTE_BASE}/releases && test -d {REMOTE_BASE}/shared && echo OK", timeout=10)
    if "OK" in r.get("stdout", ""):
        log("structure", "ok", "Estrutura de atomic releases criada com sucesso")
        return True

    log("structure", "error", "Falha ao criar estrutura de atomic releases")
    return False


def _check_buffer_health():
    """
    Verifica se o WhatsApp Buffer está UP no servidor.
    Tenta: 1) curl porta 3001  2) docker ps  3) ss porta 3001
    """
    r = _ssh("curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/ --max-time 5", timeout=15)
    if r["success"]:
        code = r.get("stdout", "").strip().strip("'")
        if code and code != "000":
            return {"up": True, "method": "http", "detail": f"HTTP {code}"}

    r = _ssh("docker ps --format '{{.Names}} {{.Status}}' 2>/dev/null | grep -i buffer", timeout=15)
    if r["success"] and r.get("stdout", "").strip():
        return {"up": True, "method": "docker", "detail": r["stdout"].strip()}

    r = _ssh("ss -tlnp 2>/dev/null | grep ':3001 ' || netstat -tlnp 2>/dev/null | grep ':3001 '", timeout=15)
    if r["success"] and r.get("stdout", "").strip():
        return {"up": True, "method": "port", "detail": "Porta 3001 em LISTEN"}

    return {"up": False, "method": "all_failed", "detail": "Nenhum método detectou o buffer ativo"}


def _get_current_branch():
    """Retorna a branch atual do repositório local."""
    r = execute_command("git rev-parse --abbrev-ref HEAD", cwd=LOCAL_PATH)
    return r.get("stdout", "").strip() if r["success"] else None


def _get_git_status():
    """Retorna se há alterações não commitadas."""
    r = execute_command("git status --porcelain", cwd=LOCAL_PATH)
    return r.get("stdout", "").strip() if r["success"] else ""


def _ensure_main_branch(log):
    """
    Garante que estamos na branch main e que está atualizada.
    O deploy SEMPRE parte da main (que é a branch de produção).
    """
    current = _get_current_branch()
    if current != "main":
        log("git-branch", "running", f"Alternando de '{current}' para 'main'...")
        r = execute_command("git checkout main", cwd=LOCAL_PATH, timeout=30)
        if not r["success"]:
            log("git-branch", "error", f"Falha ao trocar para main: {r.get('stderr', '')[:200]}")
            return False

    # Pull para garantir que temos o último merge da develop
    log("git-pull", "running", "Atualizando main com GitHub...")
    r = execute_command("git pull origin main", cwd=LOCAL_PATH, timeout=60)
    if not r["success"]:
        log("git-pull", "error", f"Git pull falhou: {r.get('stderr', '')[:200]}")
        return False
    log("git-pull", "ok", "Branch main atualizada")
    return True


def _restore_branch(original_branch):
    """Volta para a branch original após o deploy."""
    if original_branch and original_branch != "main":
        execute_command(f"git checkout {original_branch}", cwd=LOCAL_PATH, timeout=15)


# ─── Sync Leads: prod → local ───────────────────────────────────────────────

_LEADS_TABLES = ["partners", "leads", "lead_interactions"]


def _parse_db_url(url: str):
    """Extrai componentes de uma DATABASE_URL postgresql://user:pass@host:port/db."""
    m = re.match(r'postgresql(?:\+\w+)?://([^:]+):([^@]+)@([^:/]+):?(\d+)?/([^?]+)', url)
    if not m:
        return None
    user, password, host, port, dbname = m.groups()
    return {"user": user, "password": password, "host": host,
            "port": port or "5432", "dbname": dbname}


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


async def sync_leads_from_prod(log_callback=None):
    """
    Puxa novos leads/interações do servidor de produção para o banco local.
    Fluxo: prod → dump → SCP → patch ON CONFLICT → import local
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

    # 0: SSH
    log("ssh", "running", f"Conectando ao servidor {SERVER_IP}...")
    r = _ssh("echo ok", timeout=15)
    if not r.get("success"):
        log("ssh", "error", f"Sem acesso SSH ao servidor {SERVER_IP}")
        return {"success": False, "logs": logs}
    log("ssh", "ok", "SSH OK")

    # 1: DATABASE_URL do servidor
    log("db-url", "running", "Lendo DATABASE_URL do servidor...")
    r = _ssh(
        f"grep '^DATABASE_URL=' {REMOTE_BASE}/shared/.env | cut -d'=' -f2- | tr -d '\"' | tr -d \"'\"",
        timeout=15
    )
    prod_url = r.get("stdout", "").strip()
    if not prod_url:
        # Fallback: tenta no current (ou .env direto na raiz)
        r = _ssh(
            f"grep '^DATABASE_URL=' {REMOTE_BASE}/current/.env 2>/dev/null || "
            f"grep '^DATABASE_URL=' {REMOTE_BASE}/.env 2>/dev/null | cut -d'=' -f2- | tr -d '\"' | tr -d \"'\"",
            timeout=15
        )
        prod_url = r.get("stdout", "").strip()
    if not prod_url:
        log("db-url", "error", "DATABASE_URL não encontrada no servidor")
        return {"success": False, "logs": logs}
    creds = _parse_db_url(prod_url)
    if not creds:
        log("db-url", "error", f"Formato de DATABASE_URL inesperado")
        return {"success": False, "logs": logs}
    log("db-url", "ok", "Banco prod localizado")

    # 2: pg_dump no servidor
    tables_arg = " ".join(f"--table={t}" for t in _LEADS_TABLES)
    pg_env = f'PGPASSWORD="{creds["password"]}"'
    pg_conn = f'-U {creds["user"]} -h {creds["host"]} -p {creds["port"]} -d {creds["dbname"]}'
    dump_cmd = (
        f'{pg_env} pg_dump {pg_conn} '
        f'--data-only --column-inserts {tables_arg} '
        f'> {DUMP_REMOTE} 2>/tmp/leads_dump_err.txt && echo "DUMP_OK"'
    )
    log("pg-dump", "running", f"Dump das tabelas {', '.join(_LEADS_TABLES)} no servidor...")
    r = _ssh(dump_cmd, timeout=180)
    if not r.get("success") or "DUMP_OK" not in r.get("stdout", ""):
        err_r = _ssh("cat /tmp/leads_dump_err.txt 2>/dev/null | tail -10", timeout=10)
        log("pg-dump", "error", f"pg_dump falhou:\n{err_r.get('stdout', '')[:400]}")
        return {"success": False, "logs": logs}
    log("pg-dump", "ok", "Dump gerado")

    # 3: SCP → local
    log("scp", "running", "Transferindo dump para local...")
    key_path = os.path.expanduser(SSH_KEY)
    r = execute_command(
        f'scp -i {key_path} -o StrictHostKeyChecking=no '
        f'root@{SERVER_IP}:{DUMP_REMOTE} {DUMP_LOCAL}',
        timeout=180
    )
    if not r["success"]:
        log("scp", "error", f"SCP falhou: {(r.get('stderr') or r.get('stdout', ''))[:300]}")
        return {"success": False, "logs": logs}
    log("scp", "ok", "Dump transferido")

    # 4: Patch INSERT → ON CONFLICT
    log("patch", "running", "Aplicando ON CONFLICT (id) DO NOTHING...")
    r = execute_command(
        f'sed "s/^INSERT INTO \\([^ ]*\\) (\\(.*\\)) VALUES (\\(.*\\));$/INSERT INTO \\1 (\\2) VALUES (\\3) ON CONFLICT (id) DO NOTHING;/" '
        f'{DUMP_LOCAL} > {DUMP_PATCHED}',
        timeout=30
    )
    if not r["success"]:
        log("patch", "error", "Falha ao processar dump")
        execute_command(f"rm -f {DUMP_LOCAL} {DUMP_PATCHED}")
        return {"success": False, "logs": logs}
    log("patch", "ok", "Dump processado")

    # 5: Import local
    local_db_url = _get_local_db_url()
    if not local_db_url:
        log("import", "error", "DATABASE_URL local não encontrada")
        execute_command(f"rm -f {DUMP_LOCAL} {DUMP_PATCHED}")
        return {"success": False, "logs": logs}

    log("import", "running", "Importando no banco local...")
    r = execute_command(
        f'psql "{local_db_url}" --set ON_ERROR_STOP=off -f {DUMP_PATCHED} 2>&1 | tail -5',
        timeout=180
    )

    execute_command(f"rm -f {DUMP_LOCAL} {DUMP_PATCHED}")
    _ssh(f"rm -f {DUMP_REMOTE} /tmp/leads_dump_err.txt 2>/dev/null || true")

    count_r = execute_command(f'psql "{local_db_url}" -t -A -c "SELECT COUNT(*) FROM leads"', timeout=15)
    total_local = count_r.get("stdout", "?").strip()

    log("import", "ok", f"✓ Leads sincronizados | Total local: {total_local} leads")

    elapsed = (datetime.now() - started).total_seconds()
    success = all(l["status"] != "error" for l in logs)
    log("done", "ok" if success else "error",
        f"{'✓ Sync concluído' if success else '✗ Sync com problemas'} em {elapsed:.0f}s")

    log_execution("myclinicsoft", "leads_sync", "success" if success else "failed", logs, elapsed)
    return {"success": success, "logs": logs, "elapsed_seconds": elapsed}


# ─── Pipeline de Deploy Profissional ─────────────────────────────────────────

async def deploy(log_callback=None):
    """
    Deploy profissional do MyClinicSoft.
    log_callback(entry) — para atualizar interface em tempo real.

    Sequência:
      0. SSH check
      1. Buffer check (pré-deploy) — cancela se offline
      2. Git: garantir branch main atualizada
      3. TypeScript check (npm run check)
      4. Build local (npm run build)
      5. rsync dist/ → servidor (release atômica)
      6. npm ci + PM2 reload no servidor
      7. Health check app
      8. Health check buffer (pós-deploy)
      9. Volta para branch develop

    Em caso de falha no health check: rollback automático.
    """
    logs = []
    started = datetime.now()
    original_branch = _get_current_branch()

    def log(step, status, msg):
        entry = {"step": step, "status": status, "message": msg, "time": datetime.now().isoformat()}
        logs.append(entry)
        if log_callback:
            log_callback(entry)

    # ── 0: SSH ──
    log("ssh", "running", f"Testando conexão SSH com srv2 ({SERVER_IP})...")
    if not _check_ssh():
        log("ssh", "error",
            f"Sem acesso SSH ao servidor {SERVER_IP}. "
            "Verifique: 1) chave ~/.ssh/prod_server  "
            "2) servidor acessível  3) permissões da chave")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "SSH inacessível"}
    log("ssh", "ok", f"SSH OK → srv2 ({SERVER_IP})")

    # ── 0.5: Estrutura atômica ──
    if not _ensure_atomic_structure(log):
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Estrutura atômica falhou"}

    # ── 1: Buffer check ──
    log("buffer-pre", "running", "Verificando WhatsApp Buffer...")
    buf = _check_buffer_health()
    if not buf["up"]:
        log("buffer-pre", "error",
            f"WhatsApp Buffer OFFLINE! Deploy CANCELADO. Detalhe: {buf['detail']}")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Buffer offline"}
    log("buffer-pre", "ok", f"Buffer UP ({buf['method']}: {buf['detail']})")

    # ── 2: Git — branch main atualizada ──
    log("git", "running", "Preparando branch main para deploy...")
    uncommitted = _get_git_status()
    if uncommitted:
        log("git", "error",
            f"Há alterações não commitadas na branch '{original_branch}'! "
            f"Commit ou stash antes de deployar.\n"
            f"Arquivos: {uncommitted[:300]}")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Alterações não commitadas"}

    if not _ensure_main_branch(log):
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Falha ao atualizar main"}
    log("git", "ok", "Branch main pronta para deploy")

    # ── 3: TypeScript check ──
    log("check", "running", "npm run check (TypeScript)...")
    r = execute_command("npm run check", cwd=LOCAL_PATH, timeout=60)
    if not r["success"]:
        log("check", "error", f"TypeScript com erros:\n{(r.get('stderr') or r.get('stdout', ''))[:500]}")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "TypeScript check falhou"}
    log("check", "ok", "0 erros TypeScript")

    # ── 4: Build ──
    log("build", "running", "npm run build...")
    r = execute_command("npm run build", cwd=LOCAL_PATH, timeout=180)
    if not r["success"]:
        log("build", "error", f"Build falhou:\n{(r.get('stderr') or r.get('stdout', ''))[:500]}")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Build falhou"}

    size_r = execute_command(f"du -sh {LOCAL_PATH}/dist/")
    size_str = size_r.get("stdout", "").split()[0] if size_r["success"] else "?"
    log("build", "ok", f"Build OK ({size_str})")

    # ── 5: rsync dist/ → servidor (release atômica) ──
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    release_dir = f"{REMOTE_BASE}/releases/{timestamp}"
    shared_dir = f"{REMOTE_BASE}/shared"
    current_link = f"{REMOTE_BASE}/current"
    key_path = os.path.expanduser(SSH_KEY)

    log("rsync", "running", f"Criando release {timestamp} no servidor...")
    _ssh(f"mkdir -p {release_dir}", timeout=15)

    r = execute_command(
        f'rsync -az --delete '
        f'-e "ssh -i {key_path} -o StrictHostKeyChecking=no" '
        f'{LOCAL_PATH}/dist/ '
        f'root@{SERVER_IP}:{release_dir}/dist/',
        cwd=LOCAL_PATH,
        timeout=120
    )
    if not r["success"]:
        log("rsync", "error", f"rsync falhou: {(r.get('stderr') or r.get('stdout', ''))[:300]}")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "rsync falhou"}

    # Envia package.json + package-lock.json
    r2 = execute_command(
        f'scp -i {key_path} -o StrictHostKeyChecking=no '
        f'{LOCAL_PATH}/package.json {LOCAL_PATH}/package-lock.json '
        f'root@{SERVER_IP}:{release_dir}/',
        timeout=30
    )
    if not r2["success"]:
        log("rsync", "error", f"scp package files falhou")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "scp package files falhou"}
    log("rsync", "ok", f"Release {timestamp} sincronizada ({size_str})")

    # ── 6: Ativar release (npm ci + symlink + PM2) ──
    log("activate", "running", "Ativando release no servidor...")

    # Envia script
    script_local = "/tmp/myclinicsoft_deploy.sh"
    try:
        with open(script_local, "w") as f:
            f.write(REMOTE_DEPLOY_SCRIPT)
    except Exception as e:
        log("activate", "error", f"Falha ao criar script: {e}")
        _restore_branch(original_branch)
        return {"success": False, "logs": logs}

    execute_command(
        f'scp -i {key_path} -o StrictHostKeyChecking=no '
        f'{script_local} root@{SERVER_IP}:/tmp/myclinicsoft_deploy.sh',
        timeout=15
    )
    execute_command(f'rm -f {script_local}')

    r = _ssh(
        f'bash /tmp/myclinicsoft_deploy.sh '
        f'"{release_dir}" "{shared_dir}" "{current_link}" "{REMOTE_BASE}" "{MAX_RELEASES}" 2>&1',
        timeout=180
    )
    output = (r.get("stdout", "") + r.get("stderr", "")).strip()
    _ssh('rm -f /tmp/myclinicsoft_deploy.sh 2>/dev/null || true')

    if not r["success"] or "DEPLOY_OK" not in output:
        error_lines = [l for l in output.split('\n') if 'ERROR' in l.upper() or 'failed' in l.lower()]
        detail = '\n'.join(error_lines[:5]) if error_lines else output[-400:]
        log("activate", "error", f"Ativação falhou:\n{detail or '(sem saída)'}")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Ativação falhou"}
    log("activate", "ok", f"Release {timestamp} ativada")

    # ── 7: Health check app ──
    log("health-app", "running", "Health check...")
    MAX_WAIT = 60
    INTERVAL = 5
    elapsed_w = 0
    app_ok = False
    code = "000"

    while elapsed_w < MAX_WAIT:
        r = _ssh(
            f"curl -sf -o /dev/null -w '%{{http_code}}' {HEALTH_URL} --max-time 8",
            timeout=15
        )
        code = r.get("stdout", "").strip().strip("'")
        if r["success"] and code == "200":
            app_ok = True
            break
        time.sleep(INTERVAL)
        elapsed_w += INTERVAL
        log("health-app", "running", f"Aguardando app... {elapsed_w}s/{MAX_WAIT}s (HTTP {code or '?'})")

    if not app_ok:
        log("health-app", "error",
            f"App não respondeu após {MAX_WAIT}s (HTTP {code or '?'}) — ROLLBACK!")

        # ── ROLLBACK automático ──
        log("rollback", "running", "Executando rollback para release anterior...")
        script_rb = "/tmp/myclinicsoft_rollback.sh"
        try:
            with open(script_rb, "w") as f:
                f.write(REMOTE_ROLLBACK_SCRIPT)
            execute_command(
                f'scp -i {key_path} -o StrictHostKeyChecking=no '
                f'{script_rb} root@{SERVER_IP}:/tmp/myclinicsoft_rollback.sh',
                timeout=15
            )
            execute_command(f'rm -f {script_rb}')
            r_rb = _ssh(
                f'bash /tmp/myclinicsoft_rollback.sh "{current_link}" "{REMOTE_BASE}" 2>&1',
                timeout=60
            )
            rb_out = r_rb.get("stdout", "")
            _ssh('rm -f /tmp/myclinicsoft_rollback.sh')
            if "ROLLBACK_OK" in rb_out:
                log("rollback", "ok", f"Rollback concluído: {rb_out.strip()}")
            else:
                log("rollback", "error", f"Rollback falhou: {rb_out[:300]}")
        except Exception as e:
            log("rollback", "error", f"Rollback exception: {e}")

        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Health check falhou + rollback"}

    log("health-app", "ok", f"App UP (HTTP {code})")

    # ── 8: Buffer check pós-deploy ──
    log("buffer-post", "running", "Verificando buffer pós-deploy...")
    buf = _check_buffer_health()
    log("buffer-post", "ok" if buf["up"] else "error",
        f"Buffer {'UP' if buf['up'] else 'CAIU!'} ({buf['detail']})")

    # ── 9: Volta para branch develop ──
    _restore_branch(original_branch)
    if original_branch and original_branch != "main":
        log("git-restore", "ok", f"Voltou para branch '{original_branch}'")

    # ── Resultado final ──
    elapsed = (datetime.now() - started).total_seconds()
    success = all(l["status"] != "error" for l in logs)
    log("done", "ok" if success else "error",
        f"{'✓ Deploy concluído' if success else '✗ Deploy com problemas'} em {elapsed:.0f}s | "
        f"Release: {timestamp}")

    log_execution("myclinicsoft", "deploy", "success" if success else "failed", logs, elapsed)
    return {"success": success, "logs": logs, "elapsed_seconds": elapsed, "release": timestamp}
