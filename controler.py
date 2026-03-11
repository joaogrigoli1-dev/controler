#!/usr/bin/env python3
"""
Controler — Mesa de Controle Operacional
==========================================
Uso:  python3 controler.py
Abre: http://localhost:3001
"""

import json
import asyncio
import threading
import os
import sys
from pathlib import Path
from datetime import datetime
from contextlib import asynccontextmanager

# Auto-install
DEPS = ["fastapi", "uvicorn", "pyyaml", "psutil", "httpx"]
for dep in DEPS:
    try:
        __import__(dep)
    except ImportError:
        os.system(f"{sys.executable} -m pip install {dep} -q")

from fastapi import FastAPI, Request, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, Response
import uvicorn
import yaml
import subprocess

# Init database
from core.database import (
    init_db, get_projects, get_project, get_actions, get_rules,
    get_memory, save_memory, get_recent_logs, get_setting, set_setting,
    upsert_project, add_action, add_rule,
    get_memories, get_memories_count_by_type, get_memories_total,
    add_memory_entry, delete_memory_entry,
    get_rules_text, save_rules_text
)

# Configurações
CONFIG_PATH = Path(__file__).parent / "config" / "settings.yaml"
with open(CONFIG_PATH) as f:
    CONFIG = yaml.safe_load(f)

STATIC_DIR = Path(__file__).parent / "static"


# ════════════════════════════════════════
# Lifespan (startup/shutdown)
# ════════════════════════════════════════

@asynccontextmanager
async def lifespan(app):
    init_db()
    _seed_initial_data()
    yield


app = FastAPI(title="Controler", version="1.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

# ── Basic Auth (ativo quando BASIC_AUTH_USER e BASIC_AUTH_PASS estão definidos) ──
import base64 as _b64
import hmac as _hmac

_BASIC_USER = os.getenv("BASIC_AUTH_USER", "")
_BASIC_PASS = os.getenv("BASIC_AUTH_PASS", "")


def _check_credentials(username: str, password: str) -> bool:
    """Comparação timing-safe para evitar timing attacks."""
    if not _BASIC_USER or not _BASIC_PASS:
        return False
    user_ok = _hmac.compare_digest(username.encode(), _BASIC_USER.encode())
    pass_ok = _hmac.compare_digest(password.encode(), _BASIC_PASS.encode())
    return user_ok and pass_ok


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    """Adiciona cabeçalhos de segurança em todas as respostas."""
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "font-src 'self' data:; "
        "connect-src 'self' https://controler.net.br"
    )
    # Remove cabeçalho que expõe tecnologia do servidor
    if "server" in response.headers:
        del response.headers["server"]
    return response


@app.middleware("http")
async def basic_auth_middleware(request: Request, call_next):
    # Se as variáveis de ambiente não estiverem definidas, auth desligada (dev local)
    if not _BASIC_USER or not _BASIC_PASS:
        return await call_next(request)

    # Health-check interno do Coolify não precisa de auth
    if request.url.path in ("/health", "/api/health"):
        return await call_next(request)

    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Basic "):
        try:
            decoded = _b64.b64decode(auth_header[6:]).decode("utf-8")
            username, _, password = decoded.partition(":")
            if _check_credentials(username, password):
                return await call_next(request)
        except Exception:
            pass

    return Response(
        content="401 Unauthorized — Acesso restrito",
        status_code=401,
        headers={"WWW-Authenticate": 'Basic realm="Controler"'},
    )

# Flag global para evitar deploys simultâneos
_deploy_running = False
# Flag global para evitar syncs simultâneos
_whatsdev_sync_running = False


# ════════════════════════════════════════
# Health check (para Coolify / load balancers)
# ════════════════════════════════════════

@app.get("/health")
@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "controler"}


# ════════════════════════════════════════
# API: Projetos
# ════════════════════════════════════════

@app.get("/api/projects")
async def api_projects():
    dev_path = Path.home() / "Documents" / "DEV"
    result = []
    if dev_path.exists():
        for folder in sorted(dev_path.iterdir()):
            if folder.is_dir() and not folder.name.startswith('.'):
                result.append({
                    "name": folder.name,
                    "memoryCount": get_memories_total(folder.name)
                })
    return result


@app.get("/api/projects/{project_id}")
async def api_project(project_id: str):
    project = get_project(project_id)
    if not project:
        return JSONResponse({"error": "Projeto não encontrado"}, 404)
    project["actions"] = get_actions(project_id)
    project["rules_count"] = len(get_rules(project_id))
    return project


# ════════════════════════════════════════
# API: Deploy MyClinicSoft
# ════════════════════════════════════════

@app.get("/api/myclinicsoft/deploy/stream")
async def api_deploy_stream():
    """
    SSE endpoint — transmite cada passo do deploy em tempo real.
    O frontend conecta via EventSource e recebe eventos conforme ocorrem.
    """
    global _deploy_running

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    # Envia evento SSE formatado
    def make_event(entry: dict) -> str:
        return f"data: {json.dumps(entry, ensure_ascii=False)}\n\n"

    # Se já estiver rodando, avisa imediatamente
    if _deploy_running:
        async def already_running():
            yield make_event({"step": "lock", "status": "error",
                              "message": "Deploy já em andamento. Aguarde terminar."})
            yield make_event({"step": "__done__", "status": "done",
                              "result": {"success": False, "error": "Deploy em andamento"}})
        return StreamingResponse(already_running(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    _deploy_running = True

    # Callback thread-safe: chamado de dentro da thread do deploy
    def sync_callback(entry: dict):
        loop.call_soon_threadsafe(queue.put_nowait, entry)

    # Roda o deploy em thread separada (execute_command é síncrono/bloqueante)
    def run_in_thread():
        global _deploy_running
        try:
            import asyncio as _aio
            from devops.deploy_myclinicsoft import deploy
            result = _aio.run(deploy(log_callback=sync_callback))
        except Exception as exc:
            result = {"success": False, "error": str(exc), "logs": []}
        finally:
            _deploy_running = False
        loop.call_soon_threadsafe(queue.put_nowait, {
            "step": "__done__", "status": "done", "result": result
        })

    t = threading.Thread(target=run_in_thread, daemon=True)
    t.start()

    async def generator():
        try:
            while True:
                # Timeout de 6 min (deploy inteiro nunca deve passar disso)
                entry = await asyncio.wait_for(queue.get(), timeout=360)
                yield make_event(entry)
                if entry.get("step") == "__done__":
                    break
        except asyncio.TimeoutError:
            global _deploy_running
            _deploy_running = False
            yield make_event({"step": "timeout", "status": "error",
                              "message": "Timeout: deploy demorou mais de 6 minutos"})
            yield make_event({"step": "__done__", "status": "done",
                              "result": {"success": False, "error": "Timeout"}})

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"}
    )


@app.get("/api/myclinicsoft/whatsdev-sync/stream")
async def api_whatsdev_sync_stream():
    """
    SSE endpoint — transmite cada passo do sync WhatsDev em tempo real.
    Copia whatsapp_conversations + whatsapp_messages de Prod → Dev local.
    """
    global _whatsdev_sync_running

    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def make_event(entry: dict) -> str:
        return f"data: {json.dumps(entry, ensure_ascii=False)}\n\n"

    if _whatsdev_sync_running:
        async def already_running():
            yield make_event({"step": "lock", "status": "error",
                              "message": "Sync já em andamento. Aguarde terminar."})
            yield make_event({"step": "__done__", "status": "done",
                              "result": {"success": False, "error": "Sync em andamento"}})
        return StreamingResponse(already_running(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    _whatsdev_sync_running = True

    def sync_callback(entry: dict):
        loop.call_soon_threadsafe(queue.put_nowait, entry)

    def run_in_thread():
        global _whatsdev_sync_running
        try:
            import asyncio as _aio
            from devops.whatsdev_sync import sync
            result = _aio.run(sync(log_callback=sync_callback))
        except Exception as exc:
            result = {"success": False, "error": str(exc)}
        finally:
            _whatsdev_sync_running = False
        loop.call_soon_threadsafe(queue.put_nowait, {
            "step": "__done__", "status": "done", "result": result
        })

    t = threading.Thread(target=run_in_thread, daemon=True)
    t.start()

    async def generator():
        try:
            while True:
                entry = await asyncio.wait_for(queue.get(), timeout=300)
                yield make_event(entry)
                if entry.get("step") == "__done__":
                    break
        except asyncio.TimeoutError:
            global _whatsdev_sync_running
            _whatsdev_sync_running = False
            yield make_event({"step": "timeout", "status": "error",
                              "message": "Timeout: sync demorou mais de 5 minutos"})
            yield make_event({"step": "__done__", "status": "done",
                              "result": {"success": False, "error": "Timeout"}})

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"}
    )


@app.get("/api/myclinicsoft/last-update")
async def api_last_update():
    """
    Retorna data/hora da última modificação em arquivos do Controler OU do MyClinicSoft.
    Varre os dois projetos e retorna o mtime mais recente entre os dois.
    Ignora: __pycache__, node_modules, .git, dist, .pyc, .DS_Store,
            bd/ (SQLite muda a todo momento), arquivos binários comuns.
    """
    import os
    from datetime import datetime

    SCAN_DIRS = [
        Path(__file__).parent,                          # Controler
        Path("/Users/jhgm/Documents/DEV/myclinicsoft"),    # MyClinicSoft
    ]

    skip_dirs = {"__pycache__", "bd", "node_modules", ".git", "dist", ".next", "coverage"}
    skip_exts = {".pyc", ".DS_Store", ".db-shm", ".db-wal",
                 ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
                 ".woff", ".woff2", ".ttf", ".eot",
                 ".lock", ".map"}

    latest_mtime = 0.0
    latest_file  = ""

    for scan_root in SCAN_DIRS:
        if not scan_root.exists():
            continue
        label = scan_root.name  # "controler" ou "myclinicsoft"
        for root, dirs, files in os.walk(scan_root):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for fname in files:
                if any(fname.endswith(e) for e in skip_exts):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    mtime = os.path.getmtime(fpath)
                    if mtime > latest_mtime:
                        latest_mtime = mtime
                        rel = os.path.relpath(fpath, scan_root)
                        latest_file = f"{label}/{rel}"
                except OSError:
                    continue

    if latest_mtime:
        dt = datetime.fromtimestamp(latest_mtime)
        formatted = dt.strftime("%d/%m/%Y %H:%M")
        return {"last_update": formatted, "file": latest_file}
    return {"last_update": None, "file": ""}


@app.get("/api/myclinicsoft/status")
async def api_status():
    from core.tools import ssh_command, coolify_api

    mcs_cfg = CONFIG.get("myclinicsoft", {})
    app_uuid = mcs_cfg.get("coolify_app_uuid", "jckc0ccwssowwc0oocw80ogs")
    buf_uuid = mcs_cfg.get("coolify_buffer_uuid", "nw48cggkk4ss4g00s08s8wkw")

    # Tenta Coolify API primeiro
    app_r = coolify_api(f"/applications/{app_uuid}")
    buf_r = coolify_api(f"/applications/{buf_uuid}")

    if app_r["success"] and buf_r["success"]:
        app_status = app_r["data"].get("status", "unknown")
        buf_status = buf_r["data"].get("status", "unknown")
        app_online = "healthy" in app_status or "running" in app_status
        buf_online = "healthy" in buf_status or "running" in buf_status
        return {
            "app": {"online": app_online, "response": app_status},
            "buffer": {"online": buf_online, "response": buf_status},
            "coolify": True,
            "ssh": None,
            "checked_at": datetime.now().isoformat()
        }

    # Fallback: SSH direto
    ssh_ok = ssh_command("echo ok", timeout=10)
    if not ssh_ok["success"] or "ok" not in ssh_ok.get("stdout", ""):
        return {
            "app": {"online": False, "response": "Coolify API e SSH inacessiveis"},
            "buffer": {"online": False, "response": "Coolify API e SSH inacessiveis"},
            "coolify": False,
            "ssh": False,
            "checked_at": datetime.now().isoformat()
        }

    app_r = ssh_command("curl -s -o /dev/null -w '%{http_code}' http://localhost:5000/ --max-time 5", timeout=15)
    app_code = app_r.get("stdout", "").strip().strip("'")
    app_online = app_r["success"] and app_code and app_code != "000"

    buf_r = ssh_command("curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/ --max-time 5", timeout=15)
    buf_code = buf_r.get("stdout", "").strip().strip("'")
    buf_online = buf_r["success"] and buf_code and buf_code != "000"

    return {
        "app": {"online": app_online, "response": f"HTTP {app_code}" if app_online else app_code},
        "buffer": {"online": buf_online, "response": f"HTTP {buf_code}" if buf_online else buf_code},
        "coolify": False,
        "ssh": True,
        "checked_at": datetime.now().isoformat()
    }


# ════════════════════════════════════════
# API: Memória
# ════════════════════════════════════════

@app.get("/api/memory/{project_id}")
async def api_get_memory(project_id: str):
    mem = get_memory(project_id)
    return mem or {"content": "", "version": 0}


@app.post("/api/memory/{project_id}")
async def api_save_memory(project_id: str, request: Request):
    body = await request.json()
    version = save_memory(project_id, body.get("content", ""))
    return {"saved": True, "version": version}


# ════════════════════════════════════════
# API: Rules
# ════════════════════════════════════════

@app.get("/api/rules/{project_id}")
async def api_rules(project_id: str):
    return get_rules(project_id)


# ════════════════════════════════════════
# API: Logs
# ════════════════════════════════════════

@app.get("/api/logs/{project_id}")
async def api_logs(project_id: str):
    return get_recent_logs(project_id)


# ════════════════════════════════════════
# API: Agente IA (o motor Claude Code)
# ════════════════════════════════════════

@app.post("/api/agent/chat")
async def api_agent_chat(request: Request):
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON in request: {str(e)}"}, 400)

    try:
        message = body.get("message", "")
        project_id = body.get("project_id")
        history = body.get("history", [])
        cli_session_id = body.get("cli_session_id")  # Para continuidade de sessão

        if not message.strip():
            return JSONResponse({"response": "Mensagem vazia.", "tool_calls": [], "messages": []}, 200)

        from core.agent import chat
        result = await chat(message, history, project_id, cli_session_id)

        # Ensure all data is JSON-serializable before returning
        response_data = {
            "response": result.get("response", ""),
            "tool_calls": result.get("tool_calls", []),
            "messages": _serialize_messages(result.get("messages", [])),
            "cli_session_id": result.get("cli_session_id"),
            "cost_usd": result.get("cost_usd", 0),
            "num_turns": result.get("num_turns", 0),
            "duration_ms": result.get("duration_ms", 0)
        }
        return JSONResponse(response_data, 200)

    except Exception as e:
        import traceback
        error_msg = f"Error processing chat: {str(e)}"
        traceback.print_exc()
        return JSONResponse({
            "error": error_msg,
            "response": "",
            "tool_calls": [],
            "messages": []
        }, 500)


def _serialize_messages(messages: list) -> list:
    """
    Recursively ensure all message objects are JSON-serializable.
    Converts any non-serializable objects to strings.
    """
    import json

    def make_serializable(obj):
        if isinstance(obj, (str, int, float, bool, type(None))):
            return obj
        elif isinstance(obj, dict):
            return {k: make_serializable(v) for k, v in obj.items()}
        elif isinstance(obj, (list, tuple)):
            return [make_serializable(item) for item in obj]
        else:
            # For any other type, try str() conversion
            return str(obj)

    serializable = []
    for msg in messages:
        try:
            serializable.append(make_serializable(msg))
        except Exception as e:
            # If even that fails, store error message
            serializable.append({"role": "system", "content": f"[Serialization error: {str(e)}]"})

    return serializable


# ════════════════════════════════════════
# API: Settings
# ════════════════════════════════════════

@app.get("/api/settings/has-key")
async def api_has_key():
    """Verifica se o Claude CLI está autenticado (plano Max)."""
    try:
        import subprocess
        cli_path = os.environ.get("CLAUDE_CLI_PATH", "/Users/jhgm/.npm-global/bin/claude")
        result = subprocess.run(
            [cli_path, "auth", "status"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            import json as _json
            data = _json.loads(result.stdout)
            return {
                "has_key": data.get("loggedIn", False),
                "method": "claude_cli_max",
                "email": data.get("email", ""),
                "subscription": data.get("subscriptionType", "")
            }
    except Exception:
        pass
    return {"has_key": False, "method": "claude_cli_max"}


@app.post("/api/settings/api-key")
async def api_set_key(request: Request):
    """Legacy: mantido para compatibilidade, mas CLI usa plano Max."""
    return JSONResponse({
        "info": "O Controler agora usa Claude CLI com plano Max. Não é necessária API key.",
        "saved": False
    }, 200)


# ════════════════════════════════════════
# API: Memories (tipadas)
# ════════════════════════════════════════

@app.get("/api/memories")
async def api_get_memories(
    project: str = Query(None),
    limit: int = Query(50),
    search: str = Query(None)
):
    if not project:
        return {"memories": [], "count": 0}
    memories = get_memories(project, limit, search)
    return {"memories": memories, "count": len(memories)}


@app.post("/api/memories")
async def api_add_memory(request: Request):
    body = await request.json()
    project = body.get("project")
    content = body.get("content", "").strip()
    type_ = body.get("type", "CONTEXT")
    if not project or not content:
        return JSONResponse({"error": "project e content são obrigatórios"}, 400)
    add_memory_entry(project, type_, content)
    return {"saved": True}


@app.delete("/api/memories/{memory_id}")
async def api_delete_memory(
    memory_id: int,
    project: str = Query(None),
    reason: str = Query(None)
):
    delete_memory_entry(memory_id, project or "")
    return {"deleted": True}


# ════════════════════════════════════════
# API: Rules (texto livre)
# ════════════════════════════════════════

@app.get("/api/rules")
async def api_get_rules(project: str = Query(None)):
    if project:
        content = get_rules_text(project)
        return {"content": content}
    # Sem project: retorna regras gerais + lista de projetos com status
    general = get_rules_text(None)
    dev_path = Path.home() / "Documents" / "DEV"
    projects = []
    if dev_path.exists():
        for folder in sorted(dev_path.iterdir()):
            if folder.is_dir() and not folder.name.startswith('.'):
                txt = get_rules_text(folder.name)
                projects.append({"project": folder.name, "hasRules": bool(txt.strip())})
    return {"general": general, "projects": projects}


@app.put("/api/rules")
async def api_save_rules(request: Request):
    body = await request.json()
    project = body.get("project")  # None = regras gerais
    content = body.get("content", "")
    save_rules_text(project, content)
    return {"saved": True}


# ════════════════════════════════════════
# API: Overview
# ════════════════════════════════════════

def _git_run(folder, *args, timeout=5):
    try:
        r = subprocess.run(
            ["git", "-C", str(folder)] + list(args),
            capture_output=True, text=True, timeout=timeout
        )
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


@app.get("/api/overview")
async def api_overview():
    dev_path = Path.home() / "Documents" / "DEV"
    projects = []
    total_memories = 0
    last_global_activity = None

    if dev_path.exists():
        for folder in sorted(dev_path.iterdir()):
            if not folder.is_dir() or folder.name.startswith('.'):
                continue
            proj = folder.name
            by_type = get_memories_count_by_type(proj)
            mem_count = sum(by_type.values())
            total_memories += mem_count
            rules_txt = get_rules_text(proj)
            has_rules = bool(rules_txt.strip())
            last_commit = _git_run(folder, "log", "-1", "--format=%ci")
            last_activity = last_commit or None
            if last_activity and (last_global_activity is None or last_activity > last_global_activity):
                last_global_activity = last_activity
            projects.append({
                "name": proj,
                "memories": mem_count,
                "byType": by_type,
                "hasRules": has_rules,
                "lastActivity": last_activity
            })

    return {
        "projects": projects,
        "totalMemories": total_memories,
        "lastGlobalActivity": last_global_activity
    }


# ════════════════════════════════════════
# API: KPIs
# ════════════════════════════════════════

@app.get("/api/kpis")
async def api_kpis():
    dev_path = Path.home() / "Documents" / "DEV"
    project_kpis = []
    global_type_dist = {}
    total_memories = 0
    total_projects = 0
    projects_with_git = 0
    total_commits_7d = 0
    total_commits_30d = 0
    active_7d = 0
    rules_count = 0
    health_scores = []

    if dev_path.exists():
        for folder in sorted(dev_path.iterdir()):
            if not folder.is_dir() or folder.name.startswith('.'):
                continue
            proj = folder.name
            total_projects += 1

            by_type = get_memories_count_by_type(proj)
            mem_total = sum(by_type.values())
            total_memories += mem_total
            for t, c in by_type.items():
                global_type_dist[t] = global_type_dist.get(t, 0) + c

            rules_txt = get_rules_text(proj)
            has_rules = bool(rules_txt.strip())
            if has_rules:
                rules_count += 1

            is_git = (folder / ".git").exists()
            git_stats = {"commits7d": 0, "commits30d": 0, "totalCommits": 0,
                         "branches": 0, "lastCommit": None}
            staleness = -1

            if is_git:
                projects_with_git += 1
                total_raw = _git_run(folder, "rev-list", "--count", "HEAD")
                if total_raw.isdigit():
                    git_stats["totalCommits"] = int(total_raw)

                c7 = _git_run(folder, "log", "--oneline", "--since=7 days ago")
                git_stats["commits7d"] = len([x for x in c7.split('\n') if x]) if c7 else 0

                c30 = _git_run(folder, "log", "--oneline", "--since=30 days ago")
                git_stats["commits30d"] = len([x for x in c30.split('\n') if x]) if c30 else 0

                branches_raw = _git_run(folder, "branch", "-a")
                git_stats["branches"] = len([x for x in branches_raw.split('\n') if x]) if branches_raw else 0

                last_ci = _git_run(folder, "log", "-1", "--format=%ci")
                if last_ci:
                    git_stats["lastCommit"] = last_ci
                    try:
                        from datetime import datetime as _dt
                        # formato: "2026-03-03 13:59:38 -0300" → pega só a data/hora sem tz
                        date_part = last_ci[:19]  # "2026-03-03 13:59:38"
                        last_dt = _dt.strptime(date_part, "%Y-%m-%d %H:%M:%S")
                        staleness = (_dt.now() - last_dt).days
                    except Exception:
                        staleness = -1

                if git_stats["commits7d"] > 0:
                    active_7d += 1
                total_commits_7d += git_stats["commits7d"]
                total_commits_30d += git_stats["commits30d"]

            # Health score (0-100)
            score = 0
            score += min(30, mem_total * 3)         # memórias: até 30pts
            score += min(20, len(by_type) * 5)      # diversidade: até 20pts
            if has_rules:
                score += 20                          # tem regras: 20pts
            if git_stats["commits7d"] > 0:
                score += 20                          # ativo esta semana: 20pts
            elif git_stats["commits30d"] > 0:
                score += 10
            if git_stats["totalCommits"] > 0:
                score += 10                          # tem histórico git: 10pts
            score = min(100, score)
            health_scores.append(score)

            diversity = min(100, round(len(by_type) / 5 * 100))
            project_kpis.append({
                "project": proj,
                "health": score,
                "memories": {"total": mem_total},
                "diversity": diversity,
                "hasRules": has_rules,
                "git": git_stats,
                "staleness": staleness
            })

    avg_health = round(sum(health_scores) / len(health_scores)) if health_scores else 0
    return {
        "global": {
            "totalCommits7d": total_commits_7d,
            "totalCommits30d": total_commits_30d,
            "activeProjects7d": active_7d,
            "totalProjects": total_projects,
            "rulesCoverage": f"{rules_count}/{total_projects}",
            "totalMemories": total_memories,
            "avgMemoriesPerProject": round(total_memories / total_projects) if total_projects else 0,
            "projectsWithGit": projects_with_git,
            "avgHealth": avg_health,
            "typeDistribution": global_type_dist
        },
        "projects": project_kpis
    }


# ════════════════════════════════════════
# API: Coolify Container Monitoring
# ════════════════════════════════════════

import httpx as _httpx

_COOLIFY_URL = os.getenv("COOLIFY_URL", "http://62.72.63.18:8000")
_COOLIFY_TOKEN = os.getenv("COOLIFY_TOKEN", "")


async def _coolify_api(path: str) -> dict:
    """Helper para chamadas à API do Coolify."""
    headers = {
        "Authorization": f"Bearer {_COOLIFY_TOKEN}",
        "Accept": "application/json",
    }
    async with _httpx.AsyncClient(timeout=15.0, follow_redirects=False) as client:
        resp = await client.get(f"{_COOLIFY_URL}/api/v1{path}", headers=headers)
        resp.raise_for_status()
        return resp.json()


@app.get("/api/server/coolify/applications")
async def api_coolify_applications():
    """Retorna lista de aplicações gerenciadas pelo Coolify."""
    try:
        apps = await _coolify_api("/applications")
        result = []
        for a in apps:
            result.append({
                "uuid": a.get("uuid"),
                "name": a.get("name"),
                "status": a.get("status", "unknown"),
                "fqdn": a.get("fqdn", ""),
                "build_pack": a.get("build_pack", ""),
                "git_repository": a.get("git_repository", ""),
                "git_branch": a.get("git_branch", ""),
                "ports_exposes": a.get("ports_exposes", ""),
                "health_check_path": a.get("health_check_path", ""),
            })
        return {"applications": result, "timestamp": datetime.now().isoformat()}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/server/coolify/resources")
async def api_coolify_resources():
    """Retorna todos os recursos do servidor Coolify (apps, DBs, services)."""
    try:
        servers = await _coolify_api("/servers")
        server_uuid = servers[0]["uuid"] if servers else None
        resources = []
        if server_uuid:
            resources = await _coolify_api(f"/servers/{server_uuid}/resources")
        return {"resources": resources, "server": servers[0] if servers else None,
                "timestamp": datetime.now().isoformat()}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


_DOCKER_SOCKET = "/var/run/docker.sock"
_COOLIFY_NAME_MAP = {
    "hksw4kg8owgs0wwg0o8k4kk0": "controler",
    "jckc0ccwssowwc0oocw80ogs": "myclinicsoft",
    "nw48cggkk4ss4g00s08s8wkw": "whatsapp-buffer",
}
_COOLIFY_SERVER_UUID = "j4ws844wcg400kwsc0sswocg"


def _friendly_name(name: str) -> str:
    """Resolve Coolify UUID-based names to human-readable ones."""
    for uuid_prefix, app_name in _COOLIFY_NAME_MAP.items():
        if name.startswith(uuid_prefix):
            return app_name
    return name


async def _docker_api(path: str, method: str = "GET") -> dict | list:
    """Call Docker Engine API via Unix socket (if available)."""
    import httpx as _hx
    transport = _hx.AsyncHTTPTransport(uds=_DOCKER_SOCKET)
    async with _hx.AsyncClient(transport=transport, base_url="http://localhost", timeout=15.0) as client:
        resp = await client.request(method, path)
        resp.raise_for_status()
        return resp.json()


def _has_docker_socket() -> bool:
    return os.path.exists(_DOCKER_SOCKET)


async def _docker_stats_via_socket() -> list:
    """Get container stats via Docker Engine API (Unix socket)."""
    raw = await _docker_api("/containers/json?all=false")
    containers = []
    for c in raw:
        name = (c.get("Names") or ["/unknown"])[0].lstrip("/")
        containers.append({
            "name": name,
            "display_name": _friendly_name(name),
            "state": c.get("State", "unknown"),
            "docker_status": c.get("Status", ""),
            "image": c.get("Image", ""),
            "container_id": c.get("Id", "")[:12],
        })
    # Get stats for each container
    import asyncio as _aio

    async def _get_stats(cid: str):
        try:
            s = await _docker_api(f"/containers/{cid}/stats?stream=false&one-shot=true")
            cpu_delta = s.get("cpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0) - \
                        s.get("precpu_stats", {}).get("cpu_usage", {}).get("total_usage", 0)
            sys_delta = s.get("cpu_stats", {}).get("system_cpu_usage", 0) - \
                        s.get("precpu_stats", {}).get("system_cpu_usage", 0)
            n_cpus = s.get("cpu_stats", {}).get("online_cpus", 1) or 1
            cpu_pct = round((cpu_delta / sys_delta) * n_cpus * 100, 2) if sys_delta > 0 else 0.0
            mem = s.get("memory_stats", {})
            mem_usage = mem.get("usage", 0) - mem.get("stats", {}).get("cache", 0)
            mem_limit = mem.get("limit", 1)
            mem_pct = round((mem_usage / mem_limit) * 100, 2) if mem_limit > 0 else 0.0
            net = s.get("networks", {})
            rx = sum(v.get("rx_bytes", 0) for v in net.values())
            tx = sum(v.get("tx_bytes", 0) for v in net.values())
            pids = s.get("pids_stats", {}).get("current", 0)
            return cid, {
                "cpu_percent": f"{cpu_pct}%",
                "mem_usage": f"{mem_usage / 1048576:.1f}MiB / {mem_limit / 1048576:.0f}MiB",
                "mem_percent": f"{mem_pct}%",
                "net_io": f"{rx / 1048576:.1f}MB / {tx / 1048576:.1f}MB",
                "pids": str(pids),
            }
        except Exception:
            return cid, {}

    results = await _aio.gather(*[_get_stats(c["container_id"]) for c in containers])
    stats_map = dict(results)
    for c in containers:
        c.update(stats_map.get(c["container_id"], {}))
    return containers


async def _docker_stats_via_coolify() -> list:
    """Get container info via Coolify API (fallback, no CPU/MEM data)."""
    resources = await _coolify_api(f"/servers/{_COOLIFY_SERVER_UUID}/resources")
    containers = []
    for r in resources:
        containers.append({
            "name": r.get("uuid", ""),
            "display_name": r.get("name", "unknown"),
            "state": "running" if "running" in r.get("status", "") else r.get("status", "unknown"),
            "docker_status": r.get("status", ""),
            "image": "",
            "container_id": r.get("uuid", "")[:12],
            "type": r.get("type", ""),
            "cpu_percent": "N/A",
            "mem_usage": "N/A",
            "mem_percent": "N/A",
            "net_io": "N/A",
            "pids": "N/A",
        })
    return containers


@app.get("/api/server/docker/stats")
async def api_docker_stats():
    """Retorna docker stats — via Docker socket se disponível, senão Coolify API."""
    try:
        if _has_docker_socket():
            containers = await _docker_stats_via_socket()
            source = "docker_socket"
        else:
            containers = await _docker_stats_via_coolify()
            source = "coolify_api"
        return {
            "containers": containers,
            "total": len(containers),
            "source": source,
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/server/openclaw/status")
async def api_openclaw_status():
    """Retorna status do agente OpenClaws e seus cron jobs.
    Tries: mounted volumes → Docker API → Coolify API (fallback chain).
    """
    try:
        # ── Cron jobs ──────────────────────────────────────
        cron_data = {}
        cron_path = Path("/opt/openclaw/cron/jobs.json")
        if cron_path.exists():
            cron_data = json.loads(cron_path.read_text())

        # ── Container health ──────────────────────────────
        health_info = {"health": "unknown", "state": "unknown", "started_at": ""}
        if _has_docker_socket():
            try:
                inspect = await _docker_api("/containers/openclaw/json")
                state = inspect.get("State", {})
                health_info = {
                    "health": state.get("Health", {}).get("Status", "none"),
                    "state": state.get("Status", "unknown"),
                    "started_at": state.get("StartedAt", ""),
                }
            except Exception:
                pass

        # ── Config ─────────────────────────────────────────
        config_info = {}
        config_path = Path("/opt/openclaw/config.yml")
        if config_path.exists():
            config_info = yaml.safe_load(config_path.read_text()) or {}

        # Determine data source
        source = "mounted_volume" if cron_path.exists() else "unavailable"
        if _has_docker_socket():
            source = "docker_socket+" + source

        return {
            "container": health_info,
            "cron": cron_data,
            "config": {
                "model": config_info.get("agents", {}).get("default", {}).get("model", "unknown"),
                "cron_enabled": config_info.get("cron", {}).get("enabled", False),
                "max_concurrent": config_info.get("cron", {}).get("maxConcurrentRuns", 0),
                "gateway_port": config_info.get("gateway", {}).get("port", 0),
            },
            "source": source,
            "timestamp": datetime.now().isoformat(),
        }
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)


# ════════════════════════════════════════
# API: Hardware KPIs
# ════════════════════════════════════════

@app.get("/api/hardware")
async def api_hardware():
    """
    Retorna KPIs de consumo de hardware do servidor:
    CPU, Memória, Disco, Rede, Processos.
    """
    try:
        import psutil
        import platform as _plat

        # ── CPU ─────────────────────────────────────────
        cpu_pct  = psutil.cpu_percent(interval=0.5)
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        cpu_freq = psutil.cpu_freq()
        load_avg = [round(x, 2) for x in psutil.getloadavg()] \
                   if hasattr(psutil, "getloadavg") else [0, 0, 0]

        # ── Memória ──────────────────────────────────────
        mem  = psutil.virtual_memory()
        swap = psutil.swap_memory()

        # ── Disco ────────────────────────────────────────
        disks = []
        for part in psutil.disk_partitions(all=False):
            try:
                usage = psutil.disk_usage(part.mountpoint)
                disks.append({
                    "device":     part.device,
                    "mountpoint": part.mountpoint,
                    "fstype":     part.fstype,
                    "total":      usage.total,
                    "used":       usage.used,
                    "free":       usage.free,
                    "percent":    usage.percent,
                })
            except (PermissionError, OSError):
                continue

        # ── Rede ─────────────────────────────────────────
        net = psutil.net_io_counters()

        # ── Sistema ──────────────────────────────────────
        boot_dt      = datetime.fromtimestamp(psutil.boot_time())
        uptime_secs  = (datetime.now() - boot_dt).total_seconds()
        process_count = len(psutil.pids())

        # ── Top 5 processos por CPU ───────────────────────
        top_procs = []
        for p in sorted(
            psutil.process_iter(["pid", "name", "cpu_percent", "memory_percent", "status"]),
            key=lambda x: x.info.get("cpu_percent") or 0,
            reverse=True
        )[:5]:
            top_procs.append({
                "pid":    p.info["pid"],
                "name":   p.info["name"],
                "cpu":    round(p.info.get("cpu_percent") or 0, 1),
                "mem":    round(p.info.get("memory_percent") or 0, 1),
                "status": p.info.get("status", "?"),
            })

        return {
            "cpu": {
                "percent":        cpu_pct,
                "count_logical":  psutil.cpu_count(logical=True),
                "count_physical": psutil.cpu_count(logical=False),
                "freq_current":   round(cpu_freq.current, 0) if cpu_freq else None,
                "freq_max":       round(cpu_freq.max, 0)     if cpu_freq else None,
                "per_core":       per_core,
                "load_avg_1m":    load_avg[0],
                "load_avg_5m":    load_avg[1],
                "load_avg_15m":   load_avg[2],
            },
            "memory": {
                "total":        mem.total,
                "used":         mem.used,
                "available":    mem.available,
                "percent":      mem.percent,
                "swap_total":   swap.total,
                "swap_used":    swap.used,
                "swap_percent": swap.percent,
            },
            "disk":    disks,
            "network": {
                "bytes_sent":    net.bytes_sent,
                "bytes_recv":    net.bytes_recv,
                "packets_sent":  net.packets_sent,
                "packets_recv":  net.packets_recv,
                "errin":         net.errin,
                "errout":        net.errout,
            },
            "system": {
                "boot_time":      boot_dt.strftime("%d/%m/%Y %H:%M"),
                "uptime_hours":   round(uptime_secs / 3600, 1),
                "process_count":  process_count,
                "platform":       _plat.platform(),
                "python_version": _plat.python_version(),
            },
            "top_processes": top_procs,
            "timestamp":     datetime.now().isoformat(),
        }
    except ImportError:
        return JSONResponse(
            {"error": "psutil não instalado. Execute: pip install psutil"},
            status_code=500
        )
    except Exception as exc:
        import traceback
        traceback.print_exc()
        return JSONResponse({"error": str(exc)}, status_code=500)


# ════════════════════════════════════════
# Página principal
# ════════════════════════════════════════

@app.get("/")
async def root():
    return FileResponse(str(STATIC_DIR / "index.html"))


# ════════════════════════════════════════
# Seed: dados iniciais
# ════════════════════════════════════════

def _seed_initial_data():
    """Popula dados iniciais se o banco estiver vazio."""
    projects = get_projects()
    if projects:
        return  # Já tem dados

    # Projeto MyClinicSoft
    upsert_project(
        "myclinicsoft", "MyClinicSoft", "🏥",
        "Sistema de gestao para clinicas. Producao em 62.72.63.18 (Coolify/Docker). "
        "App principal na porta 5000 (Nixpacks), WhatsApp Buffer na porta 3001 (Docker)."
    )

    # Ação: Deploy
    add_action("myclinicsoft", "Deploy MyClinicSoft",
        "Valida TypeScript → Build local → Git push (main) → Coolify restart → Health check app + buffer",
        "deploy", {"script": "devops/deploy_myclinicsoft.py"})

    # Regras do projeto (persistidas no banco, não em arquivo de texto)
    rules = [
        ("deploy", "Direção única obrigatória",
         "O caminho de codigo e SEMPRE: Local DEV (Mac) → GitHub (main) → Coolify (62.72.63.18). "
         "O caminho inverso é PROIBIDO. Nunca puxar código de produção para local.",
         "mandatory"),

        ("buffer", "WhatsApp Buffer é intocável",
         "O WhatsApp Buffer (porta 3001, Docker) NUNCA pode ser derrubado, reiniciado ou sobrescrito durante deploy. "
         "Se o buffer estiver fora do ar, mensagens de pacientes serão PERDIDAS permanentemente. "
         "O Meta reenvia webhooks por no máximo ~72h — após isso, a mensagem some.",
         "mandatory"),

        ("buffer", "Banco whatsapp é intocável",
         "O banco PostgreSQL 'whatsapp' (separado do 'myclinicsoft') contém conversations, messages, etc. "
         "NUNCA sobrescrever ou dropar tabelas desse banco. O Buffer popula esse banco em triangulação. "
         "O DB sync do deploy só toca o banco 'myclinicsoft' — nunca o banco 'whatsapp'.",
         "mandatory"),

        ("deploy", "Validação obrigatória antes de deploy",
         "npm run check deve retornar 0 erros. npm run build deve concluir sem erro. "
         "Se falhar, o deploy NÃO pode continuar.",
         "mandatory"),

        ("deploy", "Branch obrigatório: main",
         "Deploy só pode ser feito a partir da branch main. "
         "Nunca fazer deploy de outra branch.",
         "mandatory"),

        ("security", "Credenciais nunca no código",
         "DATABASE_URL de produção NUNCA commitada. Secrets ficam APENAS em "
         "nas env vars do Coolify (nunca em código).",
         "mandatory"),

        ("buffer", "Ordem do webhook é invariante",
         "1) res.status(200) PRIMEIRO 2) queueWebhook 3) parseWebhook 4) resolveIdentity 5) INSERT. "
         "Reordenar causa perda de mensagens.",
         "mandatory"),

        ("deploy", "Rollback controlado",
         "Usar make rollback apenas quando health check falha E logs mostram erro crítico. "
         "Investigar causa ANTES de novo deploy. Buffer geralmente NÃO precisa de rollback.",
         "warning"),

        ("general", "Dados de pacientes: LGPD",
         "Nunca puxar dump de produção com dados reais para dev. "
         "Apenas schema-only ou dados anonimizados. CPF, telefone, nome — tudo substituído.",
         "mandatory"),
    ]

    for category, title, content, severity in rules:
        add_rule("myclinicsoft", category, title, content, severity)

    # Memória inicial
    save_memory("myclinicsoft",
        "# MyClinicSoft — Memória Operacional\n\n"
        "## Arquitetura\n"
        "- App Principal: Express + React, Coolify/Docker, porta 5000\n"
        "- WhatsApp Buffer: Docker, porta 3001 (CRÍTICO)\n"
        "- Banco: PostgreSQL (myclinicsoft + whatsapp — bancos separados)\n"
        "- Servidor: 62.72.63.18 (Coolify/Docker)\n"
        "- Deploy: GitHub push → Coolify API restart\n\n"
        "## Decisões Vigentes\n"
        "- Caminho único: Local → GitHub → Produção\n"
        "- Buffer nunca pode cair\n"
        "- Branch de deploy: main\n\n"
        "## Estado Atual\n"
        "- Sistema em produção estável\n"
        "- ~13.400 pacientes, 464 conversas WhatsApp\n"
        "- 140 tabelas no banco\n"
    )


# ════════════════════════════════════════
# Main
# ════════════════════════════════════════

if __name__ == "__main__":
    # Env vars têm prioridade (útil em Docker/Coolify)
    port = int(os.getenv("PORT", CONFIG.get("server", {}).get("port", 3001)))
    host = os.getenv("HOST", CONFIG.get("server", {}).get("host", "127.0.0.1"))
    print(f"\n🎛️  Controler rodando em http://{host}:{port}\n")
    if _BASIC_USER:
        print(f"🔒  Basic Auth ATIVO — usuário: {_BASIC_USER}\n")
    uvicorn.run(app, host=host, port=port, log_level="info", server_header=False)
