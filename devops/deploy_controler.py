#!/usr/bin/env python3
"""
deploy_controler.py — Deploy do Controler para Coolify
=======================================================
Executa todas as etapas de forma autônoma:
  1. Git commit + push para GitHub (branch main)
  2. Verifica/Cria application no Coolify
  3. Configura env vars (Basic Auth, HOST, PORT)
  4. Aciona deploy
  5. Aguarda e confirma status

Uso:
  cd ~/Documents/DEV/controler
  python3.12 devops/deploy_controler.py

Requisitos: git configurado, acesso ao GitHub, Coolify em 62.72.63.18:8000
"""

import os
import sys
import json
import time
import subprocess
import urllib.request
import urllib.error
from datetime import datetime

# ─── Configuração ─────────────────────────────────────────────────────────────

REPO_PATH      = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GITHUB_REPO    = "joaogrigoli1-dev/controler"
GITHUB_BRANCH  = "main"

COOLIFY_URL    = "http://62.72.63.18:8000"
COOLIFY_TOKEN  = "2|PACNSa1HBN0AkS5LKsp4x5YeNS95QirqOYyAsLg30ef58ece"
SERVER_UUID    = "j4ws844wcg400kwsc0sswocg"   # mesmo servidor do myclinicsoft
APP_UUID       = "hs8c0csogg4008o44k8w008g"  # UUID do app no Coolify (já criado)

DOMAIN         = "controler.net.br"
APP_PORT       = 3001

AUTH_USER      = "joaogrigoli1@gmail.com"
AUTH_PASS      = "#45Asvdsj"

# ─── Helpers ──────────────────────────────────────────────────────────────────

def log(msg: str, symbol: str = "▶"):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {symbol}  {msg}")

def ok(msg: str):   log(msg, "✅")
def err(msg: str):  log(msg, "❌")
def info(msg: str): log(msg, "ℹ️ ")
def warn(msg: str): log(msg, "⚠️ ")

def run(cmd: list, cwd: str = None, check: bool = True) -> subprocess.CompletedProcess:
    """Executa comando e retorna resultado."""
    result = subprocess.run(
        cmd,
        cwd=cwd or REPO_PATH,
        capture_output=True,
        text=True
    )
    if check and result.returncode != 0:
        raise RuntimeError(f"Comando falhou: {' '.join(cmd)}\n{result.stderr}")
    return result

def coolify(method: str, path: str, body: dict = None, timeout: int = 30) -> dict:
    """Requisição à Coolify API."""
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
            return {"ok": True, "status": resp.status, "data": json.loads(resp_data) if resp_data else {}}
    except urllib.error.HTTPError as e:
        body_err = ""
        try: body_err = e.read().decode()[:500]
        except: pass
        return {"ok": False, "status": e.code, "error": f"HTTP {e.code}: {body_err}"}
    except Exception as e:
        return {"ok": False, "status": 0, "error": str(e)[:300]}

# ─── Etapa 1: Git push ────────────────────────────────────────────────────────

def step_git_push():
    log("ETAPA 1 — Git commit + push para GitHub", "🔀")

    # Status
    status = run(["git", "status", "--porcelain"])
    changed_files = [l for l in status.stdout.splitlines() if l.strip()]

    if not changed_files:
        info("Nenhuma mudança local detectada.")
        # Verifica se tem commits por enviar
        ahead = run(["git", "rev-list", "--count", f"origin/{GITHUB_BRANCH}..HEAD"], check=False)
        if ahead.returncode == 0 and ahead.stdout.strip() == "0":
            info("Repositório já está sincronizado com origin/main.")
            return True
        else:
            log("Commits locais não enviados — fazendo push...", "🔄")
    else:
        log(f"{len(changed_files)} arquivo(s) modificado(s):", "📁")
        for f in changed_files[:10]:
            print(f"      {f}")

        # Garante branch main
        branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.strip()
        if branch != GITHUB_BRANCH:
            warn(f"Branch atual é '{branch}'. Mudando para '{GITHUB_BRANCH}'...")
            run(["git", "checkout", GITHUB_BRANCH])

        # Add + commit
        run(["git", "add", "-A"])
        commit_msg = f"deploy: auto-deploy [{datetime.now().strftime('%Y-%m-%d %H:%M')}]"
        run(["git", "commit", "-m", commit_msg])
        ok(f"Commit criado: {commit_msg}")

    # Push
    log("Fazendo push para origin/main...", "📤")
    push_result = run(["git", "push", "origin", GITHUB_BRANCH], check=False)
    if push_result.returncode != 0:
        # Tenta push forçado se houve divergência
        if "rejected" in push_result.stderr or "non-fast-forward" in push_result.stderr:
            warn("Push rejeitado — tentando pull + push...")
            run(["git", "pull", "--rebase", "origin", GITHUB_BRANCH])
            run(["git", "push", "origin", GITHUB_BRANCH])
        else:
            raise RuntimeError(f"Falha no push:\n{push_result.stderr}")

    ok("Push concluído com sucesso!")
    return True

# ─── Etapa 2: Verificar/Criar app no Coolify ─────────────────────────────────

def step_coolify_app() -> str:
    """Verifica se o app existe no Coolify e retorna o UUID."""
    log("ETAPA 2 — Verificar app no Coolify", "🐳")

    # Usa o UUID configurado
    app_resp = coolify("GET", f"/applications/{APP_UUID}")
    if app_resp["ok"]:
        name = app_resp["data"].get("name", "controler")
        ok(f"App encontrado no Coolify: '{name}' (uuid={APP_UUID})")
        return APP_UUID

    # Fallback: procura por nome
    apps_resp = coolify("GET", "/applications")
    if apps_resp["ok"]:
        apps = apps_resp["data"]
        if isinstance(apps, dict):
            apps = apps.get("data", [])
        for app in (apps or []):
            if isinstance(app, dict):
                name = app.get("name", "").lower()
                fqdn = app.get("fqdn", "").lower()
                if "controler" in name or DOMAIN in fqdn:
                    uuid = app.get("uuid", "")
                    ok(f"App encontrado: '{app.get('name')}' (uuid={uuid})")
                    return uuid

    raise RuntimeError(f"App não encontrado no Coolify (uuid={APP_UUID}). Crie manualmente.")

# ─── Etapa 3: Configurar env vars ────────────────────────────────────────────

def step_env_vars(app_uuid: str):
    log("ETAPA 3 — Configurar variáveis de ambiente", "⚙️")

    env_vars = [
        {"key": "HOST",             "value": "0.0.0.0",   "is_preview": False},
        {"key": "PORT",             "value": str(APP_PORT), "is_preview": False},
        {"key": "BASIC_AUTH_USER",  "value": AUTH_USER,   "is_preview": False},
        {"key": "BASIC_AUTH_PASS",  "value": AUTH_PASS,   "is_preview": False},
    ]

    # Busca env vars existentes
    existing_resp = coolify("GET", f"/applications/{app_uuid}/envs")
    existing = {}
    if existing_resp["ok"]:
        data = existing_resp["data"]
        if isinstance(data, dict):
            data = data.get("data", [])
        for e in (data or []):
            existing[e.get("key")] = e.get("uuid")

    for var in env_vars:
        key = var["key"]
        if key in existing:
            # Atualiza
            update_resp = coolify("PATCH", f"/applications/{app_uuid}/envs/{existing[key]}", body=var)
            if update_resp["ok"]:
                ok(f"Env var atualizada: {key}")
            else:
                warn(f"Falha ao atualizar {key}: {update_resp.get('error')}")
        else:
            # Cria
            create_resp = coolify("POST", f"/applications/{app_uuid}/envs", body=var)
            if create_resp["ok"]:
                ok(f"Env var criada: {key}")
            else:
                warn(f"Falha ao criar {key}: {create_resp.get('error')}")

    # Configura volume para persistência do banco
    log("Configurando volume para BD SQLite...", "💾")
    volume_payload = {
        "name": "controler-bd",
        "mount_path": "/app/bd",
    }
    vol_resp = coolify("POST", f"/applications/{app_uuid}/storages", body=volume_payload)
    if vol_resp["ok"]:
        ok("Volume /app/bd configurado.")
    else:
        warn(f"Volume já existe ou erro: {vol_resp.get('error','')}")

# ─── Etapa 4: Deploy ──────────────────────────────────────────────────────────

def step_deploy(app_uuid: str):
    log("ETAPA 4 — Acionar deploy", "🚀")

    # Endpoint correto: /deploy com uuid no body
    deploy_resp = coolify("POST", "/deploy", body={"uuid": app_uuid})
    if not deploy_resp["ok"]:
        raise RuntimeError(f"Falha ao acionar deploy: {deploy_resp.get('error')}")

    ok("Deploy acionado!")
    log("Aguardando build (até 3 minutos)...", "⏳")

    for attempt in range(36):  # 36 x 5s = 180s
        time.sleep(5)
        app_resp = coolify("GET", f"/applications/{app_uuid}")
        if app_resp["ok"]:
            status = app_resp["data"].get("status", "unknown")
            log(f"Status: {status}", "⏱️ ")
            if "running" in status or "healthy" in status:
                ok(f"Deploy concluído! Status: {status}")
                return True
            if "error" in status or "failed" in status:
                err(f"Deploy falhou! Status: {status}")
                return False
        print(".", end="", flush=True)

    warn("Timeout aguardando deploy. Verifique o Coolify manualmente.")
    return False

# ─── Etapa 5: Verificar acesso ────────────────────────────────────────────────

def step_verify():
    log("ETAPA 5 — Verificar acesso via HTTPS", "🌐")

    import base64
    credentials = base64.b64encode(f"{AUTH_USER}:{AUTH_PASS}".encode()).decode()

    for attempt in range(12):  # 12 x 10s = 120s
        time.sleep(10 if attempt > 0 else 3)
        try:
            req = urllib.request.Request(
                f"https://{DOMAIN}/health",
                headers={"Authorization": f"Basic {credentials}"}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                if resp.status == 200:
                    ok(f"Domínio {DOMAIN} está respondendo! ✨")
                    print(f"\n  🔗  https://{DOMAIN}")
                    print(f"  👤  Usuário: {AUTH_USER}")
                    print(f"  🔑  Senha: (configurada via env var)")
                    return True
        except urllib.error.HTTPError as e:
            if e.code == 401:
                info("401 — autenticação funcionando! Verifique as credenciais.")
            else:
                info(f"HTTP {e.code} — aguardando...")
        except Exception as ex:
            info(f"Aguardando DNS/SSL... ({ex.__class__.__name__})")
        print(".", end="", flush=True)

    warn(f"Domínio ainda não está acessível. DNS pode demorar até 24h.")
    warn(f"Verifique: https://{DOMAIN}")
    return False

# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    print("\n" + "="*60)
    print("  CONTROLER — Deploy Automático para Coolify")
    print("="*60 + "\n")

    try:
        # 1. Git push
        step_git_push()
        print()

        # 2. Coolify app
        app_uuid = step_coolify_app()
        print()

        # 3. Env vars
        step_env_vars(app_uuid)
        print()

        # 4. Deploy
        success = step_deploy(app_uuid)
        print()

        # 5. Verify
        if success:
            step_verify()

        print("\n" + "="*60)
        if success:
            print(f"  Deploy finalizado! Acesse: https://{DOMAIN}")
        else:
            print(f"  Deploy com problemas. Verifique o painel Coolify.")
        print("="*60 + "\n")

    except KeyboardInterrupt:
        print("\n\nDeploy cancelado pelo usuário.")
        sys.exit(1)
    except Exception as e:
        err(f"Erro fatal: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
