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
DEPS = ["fastapi", "uvicorn", "pyyaml", "psutil", "httpx", "boto3"]
for dep in DEPS:
    try:
        __import__(dep)
    except ImportError:
        os.system(f"{sys.executable} -m pip install {dep} --break-system-packages --user -q")

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
    get_rules_text, save_rules_text,
    log_agent_usage, get_daily_cost, get_today_cost,
    add_agent_finding, get_agent_findings, get_agent_findings_summary,
    update_finding_status, delete_agent_finding, get_agent_findings_count,
)

from core.ssm import get_ssm_param

CONFIG_PATH = Path(__file__).parent / "config" / "settings.yaml"
with open(CONFIG_PATH) as f:
    CONFIG = yaml.safe_load(f)

STATIC_DIR = Path(__file__).parent / "static"

# Token que os agentes OpenClaw usam para autenticar no POST /api/agent-findings
AGENT_API_TOKEN = os.getenv("AGENT_API_TOKEN", "openclaw_controler_2026")


# ════════════════════════════════════════
# Lifespan
# ════════════════════════════════════════

@asynccontextmanager
async def lifespan(app):
    init_db()
    _seed_initial_data()
    yield


app = FastAPI(title="Controler", version="2.0.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ── Basic Auth ──────────────────────────────────────────────────────────────
import base64 as _b64
import hmac as _hmac

_BASIC_USER = os.getenv("BASIC_AUTH_USER", "")
_BASIC_PASS = os.getenv("BASIC_AUTH_PASS", "")


def _check_credentials(username: str, password: str) -> bool:
    if not _BASIC_USER or not _BASIC_PASS:
        return False
    return (
        _hmac.compare_digest(username.encode(), _BASIC_USER.encode()) and
        _hmac.compare_digest(password.encode(), _BASIC_PASS.encode())
    )


@app.middleware("http")
async def security_headers_middleware(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    if "server" in response.headers:
        del response.headers["server"]
    return response


@app.middleware("http")
async def basic_auth_middleware(request: Request, call_next):
    if not _BASIC_USER or not _BASIC_PASS:
        return await call_next(request)

    # Health check e agent findings (autenticados por Bearer token) ficam livres do Basic Auth
    if request.url.path in ("/health", "/api/health"):
        return await call_next(request)
    if request.url.path == "/api/agent-findings" and request.method == "POST":
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


# Flags de deploy em andamento
_deploy_running = False


# ════════════════════════════════════════
# Health check
# ════════════════════════════════════════

@app.get("/health")
@app.get("/api/health")
async def health_check():
    return {"status": "ok", "service": "controler", "version": "2.0.0"}


# ════════════════════════════════════════
# API: Agent Findings (OpenClaw → Controler)
# ════════════════════════════════════════

def _verify_agent_token(request: Request) -> bool:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return _hmac.compare_digest(auth[7:].strip(), AGENT_API_TOKEN)
    return False


@app.post("/api/agent-findings")
async def api_create_finding(request: Request):
    """Endpoint que os agentes OpenClaw usam para reportar achados."""
    if not _verify_agent_token(request):
        return Response("401 Unauthorized", status_code=401)
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"error": "JSON inválido"}, status_code=400)

    agent_id  = body.get("agent_id", "unknown")
    project_id = body.get("project_id", "")
    type_     = body.get("type", "INFO").upper()
    severity  = body.get("severity", "info").lower()
    title     = (body.get("title") or "").strip()
    content   = body.get("content") or body.get("description") or ""
    metadata  = body.get("metadata")

    if not title:
        return JSONResponse({"error": "title é obrigatório"}, status_code=400)

    # Normaliza severity
    if severity not in ("critical", "high", "warning", "info"):
        severity = "info"

    finding_id = add_agent_finding(agent_id, project_id, type_, severity, title, content, metadata)
    return JSONResponse({"created": True, "id": finding_id}, status_code=201)


@app.get("/api/agent-findings")
async def api_list_findings(
    project:  str = Query(None),
    severity: str = Query(None),
    type:     str = Query(None),
    status:   str = Query(None),
    agent:    str = Query(None),
    limit:    int = Query(100),
    offset:   int = Query(0),
):
    findings = get_agent_findings(
        project_id=project, severity=severity, type_=type,
        status=status, agent_id=agent, limit=limit, offset=offset
    )
    return {"findings": findings, "count": len(findings)}


@app.get("/api/agent-findings/summary")
async def api_findings_summary():
    return get_agent_findings_summary()


@app.patch("/api/agent-findings/{finding_id}/status")
async def api_update_finding_status(finding_id: int, request: Request):
    body = await request.json()
    new_status = body.get("status", "")
    if new_status not in ("open", "ack", "resolved", "ignored"):
        return JSONResponse({"error": "status inválido"}, status_code=400)
    ok = update_finding_status(finding_id, new_status)
    return {"updated": ok}


@app.delete("/api/agent-findings/{finding_id}")
async def api_delete_finding(finding_id: int):
    ok = delete_agent_finding(finding_id)
    return {"deleted": ok}


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
    """SSE — transmite cada passo do deploy em tempo real."""
    global _deploy_running
    loop = asyncio.get_event_loop()
    queue: asyncio.Queue = asyncio.Queue()

    def make_event(entry: dict) -> str:
        return f"data: {json.dumps(entry, ensure_ascii=False)}\n\n"

    if _deploy_running:
        async def already_running():
            yield make_event({"step": "lock", "status": "error",
                              "message": "Deploy já em andamento. Aguarde terminar."})
            yield make_event({"step": "__done__", "status": "done",
                              "result": {"success": False, "error": "Deploy em andamento"}})
        return StreamingResponse(already_running(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    _deploy_running = True

    def sync_callback(entry: dict):
        loop.call_soon_threadsafe(queue.put_nowait, entry)

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

    threading.Thread(target=run_in_thread, daemon=True).start()

    async def generator():
        try:
            while True:
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

    return StreamingResponse(generator(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                                      "Connection": "keep-alive"})


@app.get("/api/myclinicsoft/last-update")
async def api_last_update():
    """Retorna data/hora da última modificação em arquivos do MyClinicSoft."""
    SCAN_DIR = Path(__file__).parent.parent / "myclinicsoft"
    skip_dirs = {"__pycache__", "bd", "node_modules", ".git", "dist", ".next", "coverage"}
    skip_exts = {".pyc", ".DS_Store", ".db-shm", ".db-wal",
                 ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico",
                 ".woff", ".woff2", ".ttf", ".eot", ".lock", ".map"}
    latest_mtime, latest_file = 0.0, ""
    if SCAN_DIR.exists():
        for root, dirs, files in os.walk(SCAN_DIR):
            dirs[:] = [d for d in dirs if d not in skip_dirs]
            for fname in files:
                if any(fname.endswith(e) for e in skip_exts):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    mtime = os.path.getmtime(fpath)
                    if mtime > latest_mtime:
                        latest_mtime = mtime
                        latest_file = os.path.relpath(fpath, SCAN_DIR)
                except OSError:
                    continue
    if latest_mtime:
        return {"last_update": datetime.fromtimestamp(latest_mtime).strftime("%d/%m/%Y %H:%M"),
                "file": latest_file}
    return {"last_update": None, "file": ""}


@app.get("/api/myclinicsoft/status")
async def api_status():
    """Verifica saúde do app MyClinicSoft (somente app principal)."""
    from core.tools import ssh_command, coolify_api
    mcs_cfg = CONFIG.get("myclinicsoft", {})
    app_uuid = mcs_cfg.get("coolify_app_uuid", "jckc0ccwssowwc0oocw80ogs")

    app_r = coolify_api(f"/applications/{app_uuid}")
    if app_r["success"]:
        app_status = app_r["data"].get("status", "unknown")
        app_online = "healthy" in app_status or "running" in app_status
        return {
            "app": {"online": app_online, "response": app_status},
            "coolify": True,
            "checked_at": datetime.now().isoformat()
        }

    # Fallback: SSH
    ssh_ok = ssh_command("echo ok", timeout=10)
    if not ssh_ok["success"] or "ok" not in ssh_ok.get("stdout", ""):
        return {"app": {"online": False, "response": "SSH inacessível"},
                "coolify": False, "checked_at": datetime.now().isoformat()}

    app_r = ssh_command(
        "curl -sf http://localhost:5000/api/health --max-time 5 | head -c 100", timeout=15)
    app_online = app_r["success"] and "ok" in app_r.get("stdout", "")
    return {
        "app": {"online": app_online, "response": app_r.get("stdout", "")[:80]},
        "coolify": False,
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
# API: Agente IA
# ════════════════════════════════════════

@app.post("/api/agent/chat")
async def api_agent_chat(request: Request):
    try:
        body = await request.json()
    except Exception as e:
        return JSONResponse({"error": f"Invalid JSON: {str(e)}"}, 400)

    message = body.get("message", "")
    project_id = body.get("project_id")
    history = body.get("history", [])
    cli_session_id = body.get("cli_session_id")

    if not message.strip():
        return JSONResponse({"response": "Mensagem vazia.", "tool_calls": [], "messages": []}, 200)

    from core.agent import chat
    result = await chat(message, history, project_id, cli_session_id)

    cost_usd    = result.get("cost_usd", 0)
    num_turns   = result.get("num_turns", 0)
    duration_ms = result.get("duration_ms", 0)

    if cost_usd and cost_usd > 0:
        try:
            log_agent_usage(project_id, cost_usd, num_turns, duration_ms)
        except Exception:
            pass

    return JSONResponse({
        "response":       result.get("response", ""),
        "tool_calls":     result.get("tool_calls", []),
        "messages":       _serialize_messages(result.get("messages", [])),
        "cli_session_id": result.get("cli_session_id"),
        "cost_usd":       cost_usd,
        "num_turns":      num_turns,
        "duration_ms":    duration_ms,
    }, 200)


def _serialize_messages(messages: list) -> list:
    def make_serializable(obj):
        if isinstance(obj, (str, int, float, bool, type(None))): return obj
        if isinstance(obj, dict): return {k: make_serializable(v) for k, v in obj.items()}
        if isinstance(obj, (list, tuple)): return [make_serializable(i) for i in obj]
        return str(obj)
    result = []
    for msg in messages:
        try: result.append(make_serializable(msg))
        except Exception as e: result.append({"role": "system", "content": f"[Serialization error: {e}]"})
    return result


# ════════════════════════════════════════
# API: Settings
# ════════════════════════════════════════

@app.get("/api/settings/has-key")
async def api_has_key():
    try:
        cli_path = os.environ.get("CLAUDE_CLI_PATH", "/Users/jhgm/.npm-global/bin/claude")
        result = subprocess.run([cli_path, "auth", "status"],
                                capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return {"has_key": data.get("loggedIn", False), "method": "claude_cli_max",
                    "email": data.get("email", ""), "subscription": data.get("subscriptionType", "")}
    except Exception:
        pass
    return {"has_key": False, "method": "claude_cli_max"}


@app.post("/api/settings/api-key")
async def api_set_key(request: Request):
    return JSONResponse({"info": "Use Claude CLI com plano Max.", "saved": False}, 200)


# ════════════════════════════════════════
# API: Memories (tipadas)
# ════════════════════════════════════════

@app.get("/api/memories")
async def api_get_memories(project: str = Query(None), limit: int = Query(50),
                           search: str = Query(None)):
    if not project:
        return {"memories": [], "count": 0}
    memories = get_memories(project, limit, search)
    return {"memories": memories, "count": len(memories)}


@app.post("/api/memories")
async def api_add_memory(request: Request):
    body = await request.json()
    project = body.get("project")
    content = body.get("content", "").strip()
    type_   = body.get("type", "CONTEXT")
    if not project or not content:
        return JSONResponse({"error": "project e content são obrigatórios"}, 400)
    add_memory_entry(project, type_, content)
    return {"saved": True}


@app.delete("/api/memories/{memory_id}")
async def api_delete_memory(memory_id: int, project: str = Query(None),
                             reason: str = Query(None)):
    delete_memory_entry(memory_id, project or "")
    return {"deleted": True}


# ════════════════════════════════════════
# API: Rules (texto livre)
# ════════════════════════════════════════

@app.get("/api/rules")
async def api_get_rules(project: str = Query(None)):
    if project:
        return {"content": get_rules_text(project)}
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
    save_rules_text(body.get("project"), body.get("content", ""))
    return {"saved": True}


# ════════════════════════════════════════
# API: Overview
# ════════════════════════════════════════

def _git_run(folder, *args, timeout=5):
    try:
        r = subprocess.run(["git", "-C", str(folder)] + list(args),
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else ""
    except Exception:
        return ""


@app.get("/api/overview")
async def api_overview():
    dev_path = Path.home() / "Documents" / "DEV"
    projects, total_memories, last_global_activity = [], 0, None

    if dev_path.exists():
        for folder in sorted(dev_path.iterdir()):
            if not folder.is_dir() or folder.name.startswith('.'):
                continue
            proj = folder.name
            by_type = get_memories_count_by_type(proj)
            mem_count = sum(by_type.values())
            total_memories += mem_count
            last_commit = _git_run(folder, "log", "-1", "--format=%ci")
            if last_commit and (last_global_activity is None or last_commit > last_global_activity):
                last_global_activity = last_commit
            projects.append({
                "id": proj, "name": proj,
                "memories_count": mem_count, "memories_by_type": by_type,
                "has_rules": bool(get_rules_text(proj).strip()),
                "last_commit": last_commit or None,
            })

    findings_open = get_agent_findings_count()

    return {
        "projects": projects,
        "total_projects": len(projects),
        "total_memories": total_memories,
        "last_activity": last_global_activity,
        "findings_open": findings_open,
    }


# ════════════════════════════════════════
# API: KPIs
# ════════════════════════════════════════

@app.get("/api/kpis")
async def api_kpis():
    dev_path = Path.home() / "Documents" / "DEV"
    project_kpis = []

    if dev_path.exists():
        for folder in sorted(dev_path.iterdir()):
            if not folder.is_dir() or folder.name.startswith('.'):
                continue
            proj = folder.name
            total_raw  = _git_run(folder, "rev-list", "--count", "HEAD")
            c7  = _git_run(folder, "log", "--oneline", "--since=7 days ago")
            c30 = _git_run(folder, "log", "--oneline", "--since=30 days ago")
            branches_raw = _git_run(folder, "branch", "-a")
            last_ci = _git_run(folder, "log", "-1", "--format=%ci")
            by_type = get_memories_count_by_type(proj)
            project_kpis.append({
                "project": proj,
                "commits_total":   int(total_raw) if total_raw.isdigit() else 0,
                "commits_7d":      len(c7.splitlines()) if c7 else 0,
                "commits_30d":     len(c30.splitlines()) if c30 else 0,
                "branches":        len([b for b in (branches_raw or "").splitlines() if b.strip()]),
                "last_commit":     last_ci or None,
                "memories_total":  sum(by_type.values()),
                "memories_by_type": by_type,
            })

    cost_data  = get_daily_cost(days=30)
    today_cost = get_today_cost()

    return {
        "projects": project_kpis,
        "agent_cost": {"daily": cost_data, "today": today_cost},
    }


# ════════════════════════════════════════
# API: Server — Coolify helpers internos
# ════════════════════════════════════════

_COOLIFY_TOKEN  = os.getenv("COOLIFY_TOKEN") or get_ssm_param("/myclinicsoft/coolify_token") or ""
_COOLIFY_BASE   = f"http://{os.getenv('COOLIFY_HOST','62.72.63.18')}:8000/api/v1"
_COOLIFY_SERVER_UUID = "j4ws844wcg400kwsc0sswocg"

# Mapa UUID → nome legível (inclui todos os serviços e agentes OpenClaw)
_COOLIFY_NAME_MAP = {
    "hksw4kg8owgs0wwg0o8k4kk0": "controler",
    "jckc0ccwssowwc0oocw80ogs":  "myclinicsoft",
    "yow040wosgowks8o80gk88g4":  "libertakidz",
}


def _friendly_name(name: str) -> str:
    for uuid_prefix, app_name in _COOLIFY_NAME_MAP.items():
        if name.startswith(uuid_prefix):
            return app_name
    # OpenClaw agent containers têm nome explícito
    if name.startswith("openclaw-"):
        return name
    return name


async def _coolify_api(path: str) -> list | dict:
    import httpx
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{_COOLIFY_BASE}{path}",
                             headers={"Authorization": f"Bearer {_COOLIFY_TOKEN}",
                                      "Accept": "application/json"})
        r.raise_for_status()
        return r.json()


_DOCKER_SOCKET = "/var/run/docker.sock"


def _has_docker_socket() -> bool:
    return os.path.exists(_DOCKER_SOCKET)


async def _docker_api(path: str, method: str = "GET") -> dict | list:
    import httpx
    transport = httpx.AsyncHTTPTransport(uds=_DOCKER_SOCKET)
    async with httpx.AsyncClient(transport=transport, base_url="http://localhost", timeout=15.0) as c:
        resp = await c.request(method, path)
        resp.raise_for_status()
        return resp.json()


async def _docker_stats_via_socket() -> list:
    raw = await _docker_api("/containers/json?all=false")
    containers = []
    for c in raw:
        name = (c.get("Names") or ["/unknown"])[0].lstrip("/")
        containers.append({
            "name": name, "display_name": _friendly_name(name),
            "state": c.get("State", "unknown"), "docker_status": c.get("Status", ""),
            "image": c.get("Image", ""), "container_id": c.get("Id", "")[:12],
        })

    async def _get_stats(cid: str):
        try:
            s = await _docker_api(f"/containers/{cid}/stats?stream=false&one-shot=true")
            cpu_d = (s.get("cpu_stats",{}).get("cpu_usage",{}).get("total_usage",0) -
                     s.get("precpu_stats",{}).get("cpu_usage",{}).get("total_usage",0))
            sys_d = (s.get("cpu_stats",{}).get("system_cpu_usage",0) -
                     s.get("precpu_stats",{}).get("system_cpu_usage",0))
            n_cpu = s.get("cpu_stats",{}).get("online_cpus",1) or 1
            cpu_pct = round((cpu_d / sys_d) * n_cpu * 100, 2) if sys_d > 0 else 0.0
            mem = s.get("memory_stats",{})
            mu  = mem.get("usage",0) - mem.get("stats",{}).get("cache",0)
            ml  = mem.get("limit",1)
            mem_pct = round((mu / ml) * 100, 2) if ml > 0 else 0.0
            net = s.get("networks",{})
            rx  = sum(v.get("rx_bytes",0) for v in net.values())
            tx  = sum(v.get("tx_bytes",0) for v in net.values())
            return cid, {
                "cpu_percent": f"{cpu_pct}%",
                "mem_usage":   f"{mu/1048576:.1f}MiB / {ml/1048576:.0f}MiB",
                "mem_percent": f"{mem_pct}%",
                "net_io":      f"{rx/1048576:.1f}MB / {tx/1048576:.1f}MB",
                "pids":        str(s.get("pids_stats",{}).get("current",0)),
            }
        except Exception:
            return cid, {}

    results = await asyncio.gather(*[_get_stats(c["container_id"]) for c in containers])
    stats_map = dict(results)
    for c in containers:
        c.update(stats_map.get(c["container_id"], {}))
    return containers


@app.get("/api/server/docker/stats")
async def api_docker_stats():
    try:
        if _has_docker_socket():
            containers = await _docker_stats_via_socket()
            source = "docker_socket"
        else:
            resources = await _coolify_api(f"/servers/{_COOLIFY_SERVER_UUID}/resources")
            containers = [{"name": r.get("uuid",""), "display_name": r.get("name","unknown"),
                           "state": "running" if "running" in r.get("status","") else r.get("status","unknown"),
                           "docker_status": r.get("status",""), "image": "", "container_id": r.get("uuid","")[:12],
                           "type": r.get("type",""), "cpu_percent":"N/A","mem_usage":"N/A",
                           "mem_percent":"N/A","net_io":"N/A","pids":"N/A"} for r in resources]
            source = "coolify_api"
        return {"containers": containers, "total": len(containers),
                "source": source, "timestamp": datetime.now().isoformat()}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/server/coolify/applications")
async def api_coolify_applications():
    try:
        apps = await _coolify_api("/applications")
        result = [{"uuid": a.get("uuid"), "name": a.get("name"), "status": a.get("status","unknown"),
                   "fqdn": a.get("fqdn",""), "build_pack": a.get("build_pack",""),
                   "git_repository": a.get("git_repository",""), "git_branch": a.get("git_branch",""),
                   "ports_exposes": a.get("ports_exposes",""), "health_check_path": a.get("health_check_path","")}
                  for a in apps]
        return {"applications": result, "timestamp": datetime.now().isoformat()}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.get("/api/server/coolify/resources")
async def api_coolify_resources():
    try:
        servers = await _coolify_api("/servers")
        server_uuid = servers[0]["uuid"] if servers else None
        resources = await _coolify_api(f"/servers/{server_uuid}/resources") if server_uuid else []
        return {"resources": resources, "server": servers[0] if servers else None,
                "timestamp": datetime.now().isoformat()}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


# ════════════════════════════════════════
# API: OpenClaw — Status de todos os 4 agentes
# ════════════════════════════════════════

_OPENCLAW_AGENTS = [
    {"id": "myclinicsoft",  "label": "MyClinicSoft",  "icon": "🏥",
     "volume": "/opt/openclaw-myclinicsoft", "container": "openclaw-myclinicsoft",
     "token_env": "OPENCLAW_TOKEN_MYCLINICSOFT"},
    {"id": "xospam",        "label": "XOSpam",        "icon": "🛡️",
     "volume": "/opt/openclaw-xospam",       "container": "openclaw-xospam",
     "token_env": "OPENCLAW_TOKEN_XOSPAM"},
    {"id": "libertakidz",   "label": "LibertaKidz",   "icon": "👧",
     "volume": "/opt/openclaw-libertakidz",  "container": "openclaw-libertakidz",
     "token_env": "OPENCLAW_TOKEN_LIBERTAKIDZ"},
    {"id": "controler",     "label": "Controler",      "icon": "🎛️",
     "volume": "/opt/openclaw-controler",    "container": "openclaw-controler",
     "token_env": "OPENCLAW_TOKEN_CONTROLER"},
]

# Token unificado ou por agente (fallback para o token padrão do controler)
_OPENCLAW_DEFAULT_TOKEN = os.getenv("OPENCLAW_TOKEN", "")


async def _get_agent_status(agent: dict) -> dict:
    """Coleta status de um agente OpenClaw via volume montado."""
    import httpx

    vol = Path(agent["volume"])
    token = os.getenv(agent["token_env"]) or _OPENCLAW_DEFAULT_TOKEN

    # Lê gateway token do openclaw.json no volume
    gw_token = token
    openclaw_json = vol / "openclaw.json"
    if openclaw_json.exists():
        try:
            cfg = json.loads(openclaw_json.read_text())
            gw_token = cfg.get("gateway",{}).get("auth",{}).get("token", token) or token
        except Exception:
            pass

    # Porta do gateway (padrão 18789)
    gw_port = 18789
    if openclaw_json.exists():
        try:
            cfg = json.loads(openclaw_json.read_text())
            gw_port = cfg.get("gateway",{}).get("port", 18789)
        except Exception:
            pass

    # Container name → porta interna (cada agente tem a mesma porta 18789 no seu próprio namespace)
    container = agent["container"]

    # Status via Docker socket
    container_health = {"health": "unknown", "state": "unknown", "started_at": ""}
    if _has_docker_socket():
        try:
            inspect = await _docker_api(f"/containers/{container}/json")
            state = inspect.get("State", {})
            container_health = {
                "health":     state.get("Health", {}).get("Status", "none"),
                "state":      state.get("Status", "unknown"),
                "started_at": state.get("StartedAt", ""),
            }
        except Exception:
            pass

    # Cron jobs via volume
    cron_jobs = []
    jobs_path = vol / "cron" / "jobs.json"
    if jobs_path.exists():
        try:
            raw = json.loads(jobs_path.read_text())
            jobs_list = raw if isinstance(raw, list) else raw.get("jobs", raw.get("items", []))
            for j in jobs_list:
                if isinstance(j, dict):
                    cron_jobs.append({
                        "id":          j.get("id",""),
                        "name":        j.get("name",""),
                        "schedule":    j.get("schedule",{}),
                        "model":       j.get("payload",{}).get("model","default"),
                        "last_status": j.get("state",{}).get("lastRunStatus",""),
                        "last_run":    j.get("state",{}).get("lastRunAtMs"),
                        "next_run":    j.get("state",{}).get("nextRunAtMs"),
                    })
        except Exception:
            pass

    # Modelo primário configurado
    primary_model = "unknown"
    if openclaw_json.exists():
        try:
            cfg = json.loads(openclaw_json.read_text())
            primary_model = cfg.get("agents",{}).get("defaults",{}).get("model",{}).get("primary","unknown")
        except Exception:
            pass

    return {
        "id":             agent["id"],
        "label":          agent["label"],
        "icon":           agent["icon"],
        "container":      container_health,
        "cron_jobs":      cron_jobs,
        "primary_model":  primary_model,
        "volume_exists":  vol.exists(),
    }


@app.get("/api/server/openclaw/status")
async def api_openclaw_status():
    """Status de todos os 4 agentes OpenClaw."""
    try:
        results = await asyncio.gather(*[_get_agent_status(a) for a in _OPENCLAW_AGENTS],
                                       return_exceptions=True)
        agents = []
        for r in results:
            if isinstance(r, Exception):
                agents.append({"error": str(r)})
            else:
                agents.append(r)
        return {"agents": agents, "timestamp": datetime.now().isoformat()}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


@app.post("/api/server/openclaw/crons/{agent_id}/{job_id}/run")
async def api_openclaw_run_cron(agent_id: str, job_id: str):
    """Dispara manualmente um cron job de um agente específico."""
    agent = next((a for a in _OPENCLAW_AGENTS if a["id"] == agent_id), None)
    if not agent:
        return JSONResponse({"error": f"Agente '{agent_id}' não encontrado"}, 404)

    vol = Path(agent["volume"])
    gw_token = _OPENCLAW_DEFAULT_TOKEN
    try:
        cfg = json.loads((vol / "openclaw.json").read_text())
        gw_token = cfg.get("gateway",{}).get("auth",{}).get("token", gw_token) or gw_token
    except Exception:
        pass

    import httpx
    container = agent["container"]
    try:
        async with httpx.AsyncClient(timeout=40) as client:
            r = await client.post(
                f"http://{container}:18789/api/crons/{job_id}/run",
                headers={"Authorization": f"Bearer {gw_token}"},
            )
            return JSONResponse(r.json(), status_code=r.status_code)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


# ════════════════════════════════════════
# API: Hardware KPIs
# ════════════════════════════════════════

@app.get("/api/hardware")
async def api_hardware():
    try:
        import psutil, platform as _plat
        cpu_pct  = psutil.cpu_percent(interval=0.5)
        per_core = psutil.cpu_percent(interval=None, percpu=True)
        cpu_freq = psutil.cpu_freq()
        load_avg = [round(x, 2) for x in psutil.getloadavg()] if hasattr(psutil, "getloadavg") else [0,0,0]
        mem  = psutil.virtual_memory()
        swap = psutil.swap_memory()
        disks = []
        for part in psutil.disk_partitions(all=False):
            try:
                u = psutil.disk_usage(part.mountpoint)
                disks.append({"device": part.device, "mountpoint": part.mountpoint,
                               "fstype": part.fstype, "total": u.total, "used": u.used,
                               "free": u.free, "percent": u.percent})
            except (PermissionError, OSError):
                continue
        net  = psutil.net_io_counters()
        boot = datetime.fromtimestamp(psutil.boot_time())
        top_procs = []
        for p in sorted(psutil.process_iter(["pid","name","cpu_percent","memory_percent","status"]),
                        key=lambda x: x.info.get("cpu_percent") or 0, reverse=True)[:5]:
            top_procs.append({"pid": p.info["pid"], "name": p.info["name"],
                               "cpu": round(p.info.get("cpu_percent") or 0, 1),
                               "mem": round(p.info.get("memory_percent") or 0, 1),
                               "status": p.info.get("status","?")})
        return {
            "cpu": {"percent": cpu_pct, "count_logical": psutil.cpu_count(logical=True),
                    "count_physical": psutil.cpu_count(logical=False),
                    "freq_current": round(cpu_freq.current,0) if cpu_freq else None,
                    "freq_max": round(cpu_freq.max,0) if cpu_freq else None,
                    "per_core": per_core, "load_avg_1m": load_avg[0],
                    "load_avg_5m": load_avg[1], "load_avg_15m": load_avg[2]},
            "memory": {"total": mem.total, "used": mem.used, "available": mem.available,
                       "percent": mem.percent, "swap_total": swap.total,
                       "swap_used": swap.used, "swap_percent": swap.percent},
            "disk": disks,
            "network": {"bytes_sent": net.bytes_sent, "bytes_recv": net.bytes_recv,
                        "packets_sent": net.packets_sent, "packets_recv": net.packets_recv,
                        "errin": net.errin, "errout": net.errout},
            "system": {"boot_time": boot.strftime("%d/%m/%Y %H:%M"),
                       "uptime_hours": round((datetime.now()-boot).total_seconds()/3600,1),
                       "process_count": len(psutil.pids()), "platform": _plat.platform(),
                       "python_version": _plat.python_version()},
            "top_processes": top_procs,
            "timestamp": datetime.now().isoformat(),
        }
    except ImportError:
        return JSONResponse({"error": "psutil não instalado"}, status_code=500)
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=500)


# ════════════════════════════════════════
# Credenciais (AWS SSM)
# ════════════════════════════════════════

_SSM_CACHE = {"data": None, "ts": 0}
_SSM_CACHE_TTL = 300

def _fetch_ssm_parameters():
    import time, boto3
    now = time.time()
    if _SSM_CACHE["data"] and (now - _SSM_CACHE["ts"]) < _SSM_CACHE_TTL:
        return _SSM_CACHE["data"]
    try:
        session = boto3.Session(profile_name="cowork-admin", region_name="us-east-1")
    except Exception:
        session = boto3.Session(region_name="us-east-1")
    ssm = session.client("ssm")
    params, next_token = [], None
    while True:
        kwargs = {"Path": "/", "Recursive": True, "WithDecryption": True, "MaxResults": 10}
        if next_token:
            kwargs["NextToken"] = next_token
        resp = ssm.get_parameters_by_path(**kwargs)
        params.extend(resp.get("Parameters", []))
        next_token = resp.get("NextToken")
        if not next_token:
            break
    PROJECT_MAP = {
        "srv1":        {"name": "Servidor (srv1)",   "icon": "🖥️",  "project": "infraestrutura"},
        "claude_api":  {"name": "Claude API",        "icon": "🤖",  "project": "controler"},
        "cloudflare":  {"name": "Cloudflare",        "icon": "☁️",  "project": "infraestrutura"},
        "smtp":        {"name": "SMTP / Email",      "icon": "📧",  "project": "infraestrutura"},
        "openclaws":   {"name": "OpenClaw Agents",   "icon": "🦞",  "project": "openclaws"},
        "myclinicsoft":{"name": "MyClinicSoft",      "icon": "🏥",  "project": "myclinicsoft"},
        "libertakidz": {"name": "LibertaKidz",       "icon": "👧",  "project": "libertakidz"},
        "shared":      {"name": "Compartilhados",    "icon": "🔗",  "project": "infraestrutura"},
        "credentials": {"name": "AWS Credentials",   "icon": "🔑",  "project": "infraestrutura"},
    }
    services = {}
    for p in params:
        parts = p["Name"].strip("/").split("/")
        svc = parts[0] if parts else "other"
        key = "/".join(parts[1:]) if len(parts) > 1 else parts[0]
        if svc not in services:
            meta = PROJECT_MAP.get(svc, {"name": svc.title(), "icon": "📦", "project": "outros"})
            services[svc] = {"service": svc, "name": meta["name"], "icon": meta["icon"],
                             "project": meta["project"], "params": []}
        services[svc]["params"].append({"key": key, "value": p["Value"], "type": p["Type"],
                                        "version": p.get("Version", 1),
                                        "lastModified": p["LastModifiedDate"].isoformat() if p.get("LastModifiedDate") else None})
    result = {"services": list(services.values()), "total": len(params), "cached": False}
    _SSM_CACHE["data"] = result
    _SSM_CACHE["ts"] = now
    return result


@app.get("/api/credentials")
async def get_credentials():
    try:
        return JSONResponse(_fetch_ssm_parameters())
    except Exception as exc:
        return JSONResponse({"error": str(exc), "services": [], "total": 0}, status_code=500)


@app.post("/api/credentials/refresh")
async def refresh_credentials():
    _SSM_CACHE["data"] = None
    _SSM_CACHE["ts"] = 0
    try:
        return JSONResponse(_fetch_ssm_parameters())
    except Exception as exc:
        return JSONResponse({"error": str(exc), "services": [], "total": 0}, status_code=500)


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
    if get_projects():
        return

    upsert_project("myclinicsoft", "MyClinicSoft", "🏥",
                   "Sistema de gestão de clínicas. Produção em 62.72.63.18 (Coolify). "
                   "App principal na porta 5000 (Nixpacks).")

    upsert_project("xospam", "XOSpam", "🛡️",
                   "Sistema anti-spam e gestão de emails. Pipeline de filtragem com IA.")

    upsert_project("libertakidz", "LibertaKidz", "👧",
                   "Ecossistema de segurança infantil + servidor de email Stalwart.")

    upsert_project("controler", "Controler", "🎛️",
                   "Mesa de controle operacional. Agrega findings dos agentes OpenClaw.")

    add_action("myclinicsoft", "Deploy MyClinicSoft",
               "TypeScript check → Build → Git push (main) → Coolify restart → Health check",
               "deploy", {"script": "devops/deploy_myclinicsoft.py"})

    rules = [
        ("deploy", "Direção única obrigatória",
         "Código SEMPRE: Mac DEV → GitHub (main) → Coolify. Nunca editar direto no srv1.",
         "mandatory"),
        ("deploy", "NUNCA reiniciar myclinicsoft sem autorização",
         "O container myclinicsoft está em produção. Reiniciar apenas com autorização explícita.",
         "mandatory"),
        ("security", "NUNCA apagar arquivos myclinicsoft",
         "Proibido deletar arquivos na pasta myclinicsoft ou no banco de dados myclinicsoft.",
         "mandatory"),
        ("agent", "Janela de notificação",
         "CRITICAL: 24/7. WARNING: seg-sex 7h-21h BRT. INFO: apenas Controler, sem push.",
         "info"),
    ]
    for cat, title, content, sev in rules:
        add_rule("myclinicsoft", cat, title, content, sev)


# ════════════════════════════════════════
# Entrypoint
# ════════════════════════════════════════

if __name__ == "__main__":
    port = CONFIG.get("server", {}).get("port", 3001)
    uvicorn.run("controler:app", host="0.0.0.0", port=port, reload=False, log_level="info")
