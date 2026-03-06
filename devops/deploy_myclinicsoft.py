"""
Deploy MyClinicSoft — via Coolify API
======================================
Fluxo: develop (dev) → PR → main (GitHub) → Coolify auto-build → prod

Servidores:
  - srv1 (prod): 62.72.63.18 — Coolify (Docker/Nixpacks)
  - Mac local:   desenvolvimento

Arquitetura de deploy (Coolify):
  - GitHub push → Coolify detecta (ou API trigger) → build Nixpacks → container restart
  - Sem rsync, sem PM2, sem atomic releases manuais
  - Coolify gerencia volumes, env vars, health checks, rollback

Regras do workflow:
  1. Desenvolvimento acontece na branch 'develop'
  2. Deploy para produção SOMENTE via merge da 'develop' na 'main'
  3. O deploy faz push para GitHub main e aciona Coolify via API
  4. Rollback via Coolify API (re-deploy commit anterior)
  5. Banco de dados: migrations via Drizzle
  6. WhatsApp Buffer NUNCA pode ser afetado pelo deploy
"""

import os
import json
import time
import urllib.request
import urllib.error
from datetime import datetime
from core.tools import execute_command, ssh_command
from core.database import log_execution, get_rules

# ─── Configuração ────────────────────────────────────────────────────────────

LOCAL_PATH   = "/Users/jhgm/Documents/DEV/myclinicsoft"
GITHUB_REPO  = "joaogrigoli1-dev/myclinicsoft"

# Coolify
COOLIFY_URL       = "http://62.72.63.18:8000"
COOLIFY_TOKEN     = "2|PACNSa1HBN0AkS5LKsp4x5YeNS95QirqOYyAsLg30ef58ece"
COOLIFY_APP_UUID  = "jckc0ccwssowwc0oocw80ogs"
COOLIFY_BUF_UUID  = "nw48cggkk4ss4g00s08s8wkw"

# SSH (para health checks diretos e diagnóstico)
SERVER_IP = "62.72.63.18"
SSH_KEY   = "~/.ssh/coolify_server"


# ─── Coolify API helpers ─────────────────────────────────────────────────────

def _coolify_request(method: str, path: str, body: dict = None, timeout: int = 30) -> dict:
    """Faz requisição para a Coolify API."""
    url = f"{COOLIFY_URL}/api/v1{path}"
    data = json.dumps(body).encode() if body else None
    headers = {
        "Authorization": f"Bearer {COOLIFY_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            resp_data = resp.read().decode()
            return {
                "success": True,
                "status": resp.status,
                "data": json.loads(resp_data) if resp_data else {}
            }
    except urllib.error.HTTPError as e:
        body_err = ""
        try:
            body_err = e.read().decode()[:500]
        except Exception:
            pass
        return {"success": False, "status": e.code, "error": f"HTTP {e.code}: {body_err}"}
    except Exception as e:
        return {"success": False, "status": 0, "error": str(e)[:300]}


def _coolify_get_app(uuid: str) -> dict:
    """Retorna info de uma application Coolify."""
    return _coolify_request("GET", f"/applications/{uuid}")


def _coolify_restart(uuid: str) -> dict:
    """Aciona restart/redeploy de uma application Coolify."""
    return _coolify_request("POST", f"/applications/{uuid}/restart")


def _coolify_app_status(uuid: str) -> str:
    """Retorna status de uma application: running:healthy, exited, etc."""
    r = _coolify_get_app(uuid)
    if r["success"]:
        return r["data"].get("status", "unknown")
    return "unknown"


# ─── Funções auxiliares ──────────────────────────────────────────────────────

def _ssh(cmd, timeout=30):
    """Executa comando SSH no servidor (para health checks diretos)."""
    return ssh_command(cmd, host=SERVER_IP, key=SSH_KEY, timeout=timeout)


def _check_buffer_health():
    """
    Verifica se o WhatsApp Buffer está UP.
    Tenta: 1) Coolify status  2) SSH curl porta 3001
    """
    # Via Coolify API
    status = _coolify_app_status(COOLIFY_BUF_UUID)
    if "healthy" in status or "running" in status:
        return {"up": True, "method": "coolify", "detail": status}

    # Fallback: SSH + curl
    r = _ssh("curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/ --max-time 5", timeout=15)
    if r["success"]:
        code = r.get("stdout", "").strip().strip("'")
        if code and code != "000":
            return {"up": True, "method": "http", "detail": f"HTTP {code}"}

    return {"up": False, "method": "all_failed", "detail": "Buffer não detectado"}


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

import re

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
    Fluxo: prod (SSH) → pg_dump → SCP → patch ON CONFLICT → import local
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

    # 1: DATABASE_URL do servidor (via container exec ou env var)
    log("db-url", "running", "Lendo DATABASE_URL do container Coolify...")
    r = _ssh(
        f"docker exec $(docker ps -qf 'name={COOLIFY_APP_UUID}' | head -1) printenv DATABASE_URL 2>/dev/null",
        timeout=15
    )
    prod_url = r.get("stdout", "").strip()
    if not prod_url:
        # Fallback: ler do Coolify API
        app_r = _coolify_get_app(COOLIFY_APP_UUID)
        if app_r["success"]:
            # Try to find in environment variables
            envs = app_r["data"].get("environment_variables", [])
            for env in envs:
                if env.get("key") == "DATABASE_URL":
                    prod_url = env.get("value", "")
                    break
    if not prod_url:
        log("db-url", "error", "DATABASE_URL não encontrada no servidor")
        return {"success": False, "logs": logs}
    creds = _parse_db_url(prod_url)
    if not creds:
        log("db-url", "error", "Formato de DATABASE_URL inesperado")
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

    log("import", "ok", f"Leads sincronizados | Total local: {total_local} leads")

    elapsed = (datetime.now() - started).total_seconds()
    success = all(l["status"] != "error" for l in logs)
    log("done", "ok" if success else "error",
        f"{'Sync concluido' if success else 'Sync com problemas'} em {elapsed:.0f}s")

    log_execution("myclinicsoft", "leads_sync", "success" if success else "failed", logs, elapsed)
    return {"success": success, "logs": logs, "elapsed_seconds": elapsed}


# ─── Pipeline de Deploy via Coolify ──────────────────────────────────────────

async def deploy(log_callback=None):
    """
    Deploy profissional do MyClinicSoft via Coolify.
    log_callback(entry) — para atualizar interface em tempo real.

    Sequencia:
      0. Coolify API check
      1. Buffer check (pre-deploy)
      2. Git: garantir branch main atualizada
      3. TypeScript check (npm run check)
      4. Build local (npm run build) — validacao apenas
      5. Git push origin main (Coolify faz pull + build)
      6. Trigger Coolify restart via API
      7. Aguardar build + health check
      8. Health check buffer (pos-deploy)
      9. Volta para branch develop

    Em caso de falha: Coolify mantém container anterior.
    """
    logs = []
    started = datetime.now()
    original_branch = _get_current_branch()

    def log(step, status, msg):
        entry = {"step": step, "status": status, "message": msg, "time": datetime.now().isoformat()}
        logs.append(entry)
        if log_callback:
            log_callback(entry)

    # ── 0: Coolify API check ──
    log("coolify", "running", "Testando conexao com Coolify API...")
    r = _coolify_get_app(COOLIFY_APP_UUID)
    if not r["success"]:
        log("coolify", "error",
            f"Coolify API inacessivel: {r.get('error', 'unknown')}. "
            f"Verifique: 1) URL {COOLIFY_URL}  2) Token valido  3) Servidor online")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Coolify inacessivel"}

    app_status = r["data"].get("status", "unknown")
    log("coolify", "ok", f"Coolify OK — App status: {app_status}")

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
            f"Ha alteracoes nao commitadas na branch '{original_branch}'! "
            f"Commit ou stash antes de deployar.\n"
            f"Arquivos: {uncommitted[:300]}")
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Alteracoes nao commitadas"}

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

    # ── 4: Build local (validacao) ──
    log("build", "running", "npm run build (validacao local)...")
    r = execute_command("npm run build", cwd=LOCAL_PATH, timeout=180)
    if not r["success"]:
        log("build", "error", f"Build falhou:\n{(r.get('stderr') or r.get('stdout', ''))[:500]}")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Build falhou"}
    log("build", "ok", "Build local OK")

    # ── 5: Git push ──
    log("push", "running", "git push origin main...")
    r = execute_command("git push origin main", cwd=LOCAL_PATH, timeout=60)
    if not r["success"]:
        stderr = r.get("stderr", "")
        # "Everything up-to-date" is success
        if "up-to-date" not in stderr and "Everything" not in stderr:
            log("push", "error", f"Git push falhou: {stderr[:300]}")
            _restore_branch(original_branch)
            log_execution("myclinicsoft", "deploy", "failed", logs)
            return {"success": False, "logs": logs, "error": "Git push falhou"}
    log("push", "ok", "Codigo enviado para GitHub")

    # ── 6: Trigger Coolify restart ──
    log("deploy", "running", "Acionando deploy no Coolify...")
    r = _coolify_restart(COOLIFY_APP_UUID)
    if not r["success"]:
        log("deploy", "error", f"Coolify restart falhou: {r.get('error', '')[:300]}")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Coolify restart falhou"}

    deploy_uuid = r["data"].get("deployment_uuid", "unknown")
    log("deploy", "ok", f"Deploy acionado (UUID: {deploy_uuid})")

    # ── 7: Aguardar build + health check ──
    log("health-app", "running", "Aguardando Coolify build + restart...")
    MAX_WAIT = 180  # Coolify build pode demorar
    INTERVAL = 10
    elapsed_w = 0
    app_ok = False

    # Espera inicial para build iniciar
    time.sleep(15)
    elapsed_w += 15

    while elapsed_w < MAX_WAIT:
        status = _coolify_app_status(COOLIFY_APP_UUID)
        if "healthy" in status:
            app_ok = True
            break
        if "exited" in status or "error" in status:
            log("health-app", "error",
                f"Container com problema: {status}. Verifique logs no Coolify.")
            break

        time.sleep(INTERVAL)
        elapsed_w += INTERVAL
        log("health-app", "running", f"Aguardando... {elapsed_w}s/{MAX_WAIT}s (status: {status})")

    if not app_ok:
        # Fallback: tenta HTTP direto
        r = _ssh(
            "curl -sf -o /dev/null -w '%{http_code}' http://localhost:5000/api/health --max-time 8",
            timeout=15
        )
        code = r.get("stdout", "").strip().strip("'")
        if r["success"] and code == "200":
            app_ok = True

    if not app_ok:
        log("health-app", "error",
            f"App nao respondeu apos {MAX_WAIT}s. "
            "Coolify mantém container anterior — verifique logs no painel.")
        _restore_branch(original_branch)
        log_execution("myclinicsoft", "deploy", "failed", logs)
        return {"success": False, "logs": logs, "error": "Health check falhou"}

    log("health-app", "ok", f"App UP e saudavel ({elapsed_w}s)")

    # ── 8: Buffer check pos-deploy ──
    log("buffer-post", "running", "Verificando buffer pos-deploy...")
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
        f"{'Deploy concluido' if success else 'Deploy com problemas'} em {elapsed:.0f}s | "
        f"Coolify deployment: {deploy_uuid}")

    log_execution("myclinicsoft", "deploy", "success" if success else "failed", logs, elapsed)
    return {"success": success, "logs": logs, "elapsed_seconds": elapsed, "deployment": deploy_uuid}
