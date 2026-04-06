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
    get_memory, save_memory, get_recent_logs,
    # get_setting, set_setting — importados mas sem uso ativo (reservados para futuro)
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
# API: Containers (Coolify Docker)
# ════════════════════════════════════════

@app.get("/api/containers")
async def api_containers():
    """Lista containers Docker do srv1 via SSH + docker stats em tempo real."""
    import re as _re

    # SSH commands (paralelo)
    STATS_CMD = (
        "docker stats --no-stream --format "
        "'{{.Name}}|||{{.CPUPerc}}|||{{.MemUsage}}|||{{.MemPerc}}|||{{.BlockIO}}'"
    )
    PS_CMD = (
        "docker ps --format "
        "'{{.Names}}|||{{.ID}}|||{{.Image}}|||{{.Status}}|||{{.Ports}}'"
    )
    SYS_CMD = "df -h / && echo '---FREE---' && free -m | grep Mem"

    stats_r, ps_r, sys_r = await asyncio.gather(
        _ssh_run(_SRV1_HOST, _SRV1_USER, _SRV1_PASS, STATS_CMD),
        _ssh_run(_SRV1_HOST, _SRV1_USER, _SRV1_PASS, PS_CMD),
        _ssh_run(_SRV1_HOST, _SRV1_USER, _SRV1_PASS, SYS_CMD),
    )

    # Parse docker stats
    stats_map: dict = {}
    for line in stats_r["stdout"].splitlines():
        parts = line.split("|||")
        if len(parts) >= 5:
            name = parts[0].strip().lstrip("/")
            stats_map[name] = {
                "cpu": parts[1].strip(),
                "mem_usage": parts[2].strip(),
                "mem_pct": parts[3].strip(),
                "block": parts[4].strip(),
            }

    # Parse docker ps
    containers = []
    for line in ps_r["stdout"].splitlines():
        parts = line.split("|||")
        if len(parts) < 4:
            continue
        name   = parts[0].strip().lstrip("/")
        cid    = parts[1].strip()
        image  = parts[2].strip()
        status = parts[3].strip()
        ports  = parts[4].strip() if len(parts) > 4 else ""

        s = stats_map.get(name, {})
        mem_raw = s.get("mem_usage", "")   # e.g. "123.4MiB / 7.77GiB"
        mem_mb  = None
        try:
            m = _re.match(r"([\d.]+)\s*(MiB|GiB|MB|GB)", mem_raw)
            if m:
                v, unit = float(m.group(1)), m.group(2)
                mem_mb = v if "Mi" in unit or "MB" in unit else v * 1024
        except Exception:
            pass

        display = _friendly_name(name)
        containers.append({
            "id":     cid,
            "name":   display,
            "image":  image,
            "status": status,
            "cpu":    s.get("cpu"),
            "mem_mb": round(mem_mb, 1) if mem_mb is not None else None,
            "mem_pct": s.get("mem_pct"),
            "block":  s.get("block"),
            "ports":  ports[:60] if ports else "",
        })

    # Parse system stats (df raw output + free -m)
    disk_used = disk_total = disk_pct = total_mem_gb = "?"
    sys_lines = sys_r["stdout"].splitlines()
    in_free = False
    for sline in sys_lines:
        if "---FREE---" in sline:
            in_free = True
            continue
        if not in_free:
            parts = sline.split()
            if len(parts) >= 5 and parts[0] != "Filesystem":
                disk_total, disk_used = parts[1], parts[2]
                disk_pct = parts[4].replace("%", "")
        else:
            parts = sline.split()
            if len(parts) >= 3 and parts[0] == "Mem:":
                try:
                    total_mem_gb = f"{int(parts[1]) / 1024:.1f}"
                except Exception:
                    pass

    return {
        "containers":   containers,
        "disk_used":    disk_used,
        "disk_total":   disk_total,
        "disk_pct":     disk_pct,
        "total_mem_gb": total_mem_gb,
        "source":       "ssh_docker_stats" if stats_r["success"] else "error",
        "ssh_error":    stats_r.get("stderr") if not stats_r["success"] else None,
    }


@app.post("/api/containers/{app_uuid}/restart")
async def api_container_restart(app_uuid: str):
    """Restart a container via Coolify API."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.post(f"{_COOLIFY_BASE}/applications/{app_uuid}/restart",
                                  headers={"Authorization": f"Bearer {_COOLIFY_TOKEN}",
                                            "Accept": "application/json"})
            return {"success": r.status_code < 400, "status_code": r.status_code}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


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

    # Compute global aggregation expected by frontend
    total_commits_7d  = sum(p["commits_7d"] for p in project_kpis)
    total_commits_30d = sum(p["commits_30d"] for p in project_kpis)
    total_memories    = sum(p["memories_total"] for p in project_kpis)
    active_7d         = sum(1 for p in project_kpis if p["commits_7d"] > 0)
    with_rules        = sum(1 for p in project_kpis if len(get_rules(p["project"])) > 0)
    with_git          = sum(1 for p in project_kpis if p["commits_total"] > 0)
    n = len(project_kpis) or 1

    # Type distribution across all projects
    type_dist = {}
    for p in project_kpis:
        for t, c in p["memories_by_type"].items():
            type_dist[t] = type_dist.get(t, 0) + c

    # Health score: simple heuristic (commits + memories + rules coverage)
    def _health(p):
        score = 0
        if p["commits_7d"] > 0: score += 30
        elif p["commits_30d"] > 0: score += 15
        if p["memories_total"] > 2: score += 25
        elif p["memories_total"] > 0: score += 10
        if len(get_rules(p["project"])) > 0: score += 25
        if p["commits_total"] > 10: score += 20
        return min(score, 100)

    per_project = []
    for p in project_kpis:
        h = _health(p)
        per_project.append({**p, "health": h,
                            "diversity": len(p["memories_by_type"]),
                            "staleness": "ativo" if p["commits_7d"] > 0 else "inativo" if p["commits_30d"] == 0 else "lento"})

    avg_health = round(sum(_health(p) for p in project_kpis) / n)

    return {
        "projects": per_project,
        "agent_cost": {"daily": cost_data, "today": today_cost},
        "global": {
            "totalProjects": len(project_kpis),
            "totalCommits7d": total_commits_7d,
            "totalCommits30d": total_commits_30d,
            "activeProjects7d": active_7d,
            "totalMemories": total_memories,
            "avgMemoriesPerProject": round(total_memories / n, 1),
            "rulesCoverage": with_rules,
            "projectsWithGit": with_git,
            "avgHealth": avg_health,
            "typeDistribution": type_dist,
        },
    }


# ════════════════════════════════════════
# API: Server — Coolify helpers internos
# ════════════════════════════════════════

_COOLIFY_TOKEN  = os.getenv("COOLIFY_TOKEN") or get_ssm_param("/myclinicsoft/coolify_token") or ""
_COOLIFY_BASE   = f"http://{os.getenv('COOLIFY_HOST','62.72.63.18')}:8000/api/v1"
_COOLIFY_SERVER_UUID = "j4ws844wcg400kwsc0sswocg"

# ── SSH Helpers ──────────────────────────────────────────────────────────────
_SSHPASS_BIN = "/usr/local/bin/sshpass"
_SRV1_HOST   = "62.72.63.18"
_SRV1_USER   = "root"
_SRV1_PASS   = get_ssm_param("/controler/srv1_ssh_password") or ""
_FISIOMT_HOST        = "187.77.246.214"
_FISIOMT_USER        = "root"
_FISIOMT_PASS        = get_ssm_param("/controler/fisiomt_ssh_password") or ""
_FISIOMT_HESTIA_PASS = get_ssm_param("/controler/fisiomt_hestia_password") or ""


async def _ssh_run(host: str, user: str, password: str, command: str, port: int = 22) -> dict:
    """Executa comando remoto via sshpass."""
    sshpass = _SSHPASS_BIN if os.path.exists(_SSHPASS_BIN) else "sshpass"
    cmd = [
        sshpass, "-p", password,
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
        "-p", str(port), f"{user}@{host}", command,
    ]
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=25)
        return {
            "success": proc.returncode == 0,
            "stdout": stdout.decode("utf-8", errors="replace").strip(),
            "stderr": stderr.decode("utf-8", errors="replace").strip(),
            "returncode": proc.returncode,
        }
    except asyncio.TimeoutError:
        return {"success": False, "stdout": "", "stderr": "SSH timeout", "returncode": -1}
    except Exception as exc:
        return {"success": False, "stdout": "", "stderr": str(exc), "returncode": -1}


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
# Deploy — MyClinicSoft
# ════════════════════════════════════════
import uuid as _uuid_mod

_MYCLINICSOFT_PATH = Path.home() / "Documents" / "DEV" / "myclinicsoft"
_MYCLINICSOFT_UUID = "jckc0ccwssowwc0oocw80ogs"

# Job store: job_id -> {"status": "running"|"done"|"error", "logs": [...], "step": str}
_deploy_jobs: dict = {}


def _git_remote_hash(folder) -> str:
    """Busca o hash HEAD do remote (GitHub) sem fazer fetch completo."""
    try:
        r = subprocess.run(
            ["git", "-C", str(folder), "ls-remote", "origin", "refs/heads/main"],
            capture_output=True, text=True, timeout=15
        )
        if r.returncode == 0 and r.stdout.strip():
            return r.stdout.strip().split()[0]
    except Exception:
        pass
    return ""


_DEPLOY_CACHE = Path(__file__).parent / ".last_myclinicsoft_deploy"

async def _coolify_app_commit() -> str:
    """Retorna o commit hash do último deploy em produção.
    Usa cache local (.last_myclinicsoft_deploy) pois Coolify sempre retorna HEAD."""
    try:
        if _DEPLOY_CACHE.exists():
            data = json.loads(_DEPLOY_CACHE.read_text())
            return data.get("commit", "")
    except Exception:
        pass
    return ""


@app.get("/api/deploy/myclinicsoft/sync")
async def api_deploy_sync():
    """Compara commit hash nos 3 ambientes: DEV [Mac] vs GIT [GitHub] vs PROD [Coolify]."""
    local_hash  = _git_run(_MYCLINICSOFT_PATH, "rev-parse", "HEAD")
    remote_hash = await asyncio.get_event_loop().run_in_executor(
        None, lambda: _git_remote_hash(_MYCLINICSOFT_PATH)
    )
    prod_hash = await _coolify_app_commit()

    short = lambda h: h[:8] if h else "?"
    dev_eq_git  = bool(local_hash  and remote_hash and local_hash  == remote_hash)
    git_eq_prod = bool(remote_hash and prod_hash   and remote_hash == prod_hash)
    all_synced  = dev_eq_git and git_eq_prod

    if all_synced:
        sync_status = "IN_SYNC"
        sync_label  = "Todos sincronizados"
    elif not dev_eq_git and not git_eq_prod:
        sync_status = "ALL_DIFFERENT"
        sync_label  = "DEV > GIT > PROD desatualizados"
    elif not dev_eq_git:
        sync_status = "DEV_AHEAD"
        sync_label  = "DEV a frente do GIT"
    else:
        sync_status = "GIT_AHEAD_PROD"
        sync_label  = "GIT a frente do PROD"

    branch = _git_run(_MYCLINICSOFT_PATH, "rev-parse", "--abbrev-ref", "HEAD")
    dirty  = bool(_git_run(_MYCLINICSOFT_PATH, "status", "--porcelain").strip())

    return {
        "sync_status": sync_status,
        "sync_label":  sync_label,
        "all_synced":  all_synced,
        "dev_eq_git":  dev_eq_git,
        "git_eq_prod": git_eq_prod,
        "envs": {
            "dev":  {"hash": local_hash,  "short": short(local_hash),  "label": "DEV [Mac]"},
            "git":  {"hash": remote_hash, "short": short(remote_hash), "label": "GIT [GitHub]"},
            "prod": {"hash": prod_hash,   "short": short(prod_hash),   "label": "PROD [Coolify]"},
        },
        "branch": branch,
        "dirty":  dirty,
    }


@app.post("/api/deploy/myclinicsoft")
async def api_deploy_start():
    """Inicia deploy completo: TypeScript -> Build -> Git push -> Coolify -> Health."""
    active = [j for j in _deploy_jobs.values() if j["status"] == "running"]
    if active:
        return JSONResponse({"error": "Deploy ja em andamento."}, status_code=409)

    job_id = str(_uuid_mod.uuid4())[:8]
    _deploy_jobs[job_id] = {"status": "running", "logs": [], "step": "Iniciando..."}

    async def _run():
        try:
            sys.path.insert(0, str(Path(__file__).parent))

            # Garante token Coolify disponível no módulo deploy
            # (o módulo lê COOLIFY_TOKEN no import, então patchamos diretamente)
            _token = os.environ.get("COOLIFY_TOKEN") or get_ssm_param("/myclinicsoft/coolify_token") or ""
            if _token:
                os.environ["COOLIFY_TOKEN"] = _token
            import devops.deploy_myclinicsoft as _dm
            _dm.COOLIFY_TOKEN = _token  # patch var de módulo
            _deploy = _dm.deploy

            # Step labels para o tracker visual
            _STEP_LABELS = {
                "coolify":      "Coolify API",
                "buffer-pre":   "Buffer Pre",
                "git":          "Git / Branch",
                "check":        "TypeScript",
                "build":        "Build",
                "push":         "Git Push",
                "deploy":       "Deploy Coolify",
                "health-app":   "Health Check",
                "buffer-post":  "Buffer Pos",
                "git-restore":  "Restaurar Branch",
                "done":         "Concluido",
            }
            _STATUS_ICONS = {"ok": "✅", "error": "❌", "running": "⟳"}

            def _log(entry):
                # entry é um dict: {step, status, message, time}
                if isinstance(entry, dict):
                    step    = entry.get("step", "")
                    status  = entry.get("status", "")
                    msg     = entry.get("message", "")
                    icon    = _STATUS_ICONS.get(status, "•")
                    label   = _STEP_LABELS.get(step, step)
                    line    = f"[{label}] {icon} {msg}"
                    _deploy_jobs[job_id]["logs"].append(line)
                    # Atualiza step label se mudou
                    if status == "running":
                        _deploy_jobs[job_id]["step"] = f"{label}"
                    elif status == "error":
                        _deploy_jobs[job_id]["step"] = f"Erro em {label}"
                else:
                    _deploy_jobs[job_id]["logs"].append(str(entry))

            result = await _deploy(log_callback=_log)

            if result and result.get("success"):
                # Salva o commit deployado no cache local
                try:
                    import subprocess as _sp
                    commit = _sp.run(
                        ["git", "-C", str(_MYCLINICSOFT_PATH), "rev-parse", "HEAD"],
                        capture_output=True, text=True
                    ).stdout.strip()
                    _DEPLOY_CACHE.write_text(
                        json.dumps({"commit": commit, "deployed_at": datetime.now().isoformat()})
                    )
                except Exception:
                    pass
                _deploy_jobs[job_id]["status"] = "done"
                _deploy_jobs[job_id]["step"] = "Concluido com sucesso"
            else:
                err = result.get("error", "Falha no deploy") if result else "Falha no deploy"
                _deploy_jobs[job_id]["status"] = "error"
                # Mantém o step label que _log() já definiu (ex: "Erro em Git / Branch")
                # Só define se ainda estiver no estado inicial
                if _deploy_jobs[job_id]["step"] in ("Iniciando...", ""):
                    _deploy_jobs[job_id]["step"] = f"Erro: {err}"
        except Exception as exc:
            _deploy_jobs[job_id]["status"] = "error"
            _deploy_jobs[job_id]["step"] = f"Erro: {exc}"
            _deploy_jobs[job_id]["logs"].append(f"[ERRO] {exc}")

    asyncio.create_task(_run())
    return {"job_id": job_id, "status": "started"}


@app.get("/api/deploy/myclinicsoft/job/{job_id}")
async def api_deploy_job(job_id: str, since: int = Query(0)):
    """Polling: retorna status + logs novos desde o indice `since`."""
    job = _deploy_jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "Job nao encontrado."}, status_code=404)
    logs = job["logs"]
    return {
        "job_id": job_id,
        "status": job["status"],
        "step":   job["step"],
        "logs":   logs[since:],
        "total":  len(logs),
    }


# ════════════════════════════════════════
# Página principal
# ════════════════════════════════════════


# ════════════════════════════════════════
# API: VPS FisioMT (187.77.246.214) — via HestiaCP API
# ════════════════════════════════════════

_HESTIA_BASE = "https://187.77.246.214:8083/api/"


def _hestia_post(cmd: str, **kwargs) -> str:
    """Synchronous HestiaCP API call — returns raw text."""
    import urllib.request, urllib.parse, ssl
    data = {"user": "admin", "password": _FISIOMT_HESTIA_PASS,
            "returncode": "no", "cmd": cmd, **kwargs}
    body = urllib.parse.urlencode(data).encode()
    ctx  = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode    = ssl.CERT_NONE
    req  = urllib.request.Request(_HESTIA_BASE, data=body, method="POST")
    with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _parse_hestia_table(text: str) -> list:
    """Parse HestiaCP plain-text table into list of dicts."""
    lines  = [l for l in text.strip().splitlines() if l.strip()]
    if len(lines) < 2:
        return []
    # First line = headers, second = dashes, rest = data
    headers = lines[0].split()
    rows    = []
    for line in lines[2:]:
        parts = line.split()
        if not parts:
            continue
        row = {}
        for i, h in enumerate(headers):
            row[h] = parts[i] if i < len(parts) else ""
        rows.append(row)
    return rows


def _parse_hestia_kv(text: str) -> dict:
    """Parse HestiaCP key:value output into dict."""
    result = {}
    for line in text.strip().splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            result[k.strip()] = v.strip()
    return result


@app.get("/api/vps-fisiomt/stats")
async def api_vps_fisiomt_stats():
    """Métricas do servidor FisioMT via HestiaCP API."""
    import re as _re

    async def _run_info():
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: _hestia_post("v-list-sys-info"))

    async def _run_services():
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: _hestia_post("v-list-sys-services"))

    try:
        info_txt, svc_txt = await asyncio.gather(_run_info(), _run_services())
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)

    # Parse sys-info: HOSTNAME OS VER ARCH HESTIA RELEASE UPTIME LA...
    data = {
        "hostname": "", "os": "", "os_ver": "", "arch": "",
        "hestia_ver": "", "uptime_min": 0,
        "load1": 0.0, "load5": 0.0, "load15": 0.0,
        "services": [], "timestamp": datetime.now().isoformat(),
        "source": "hestia_api",
    }
    info_rows = _parse_hestia_table(info_txt)
    if info_rows:
        r = info_rows[0]
        data["hostname"]   = r.get("HOSTNAME", "")
        data["os"]         = r.get("OS", "")
        data["os_ver"]     = r.get("VER", "")
        data["arch"]       = r.get("ARCH", "")
        data["hestia_ver"] = r.get("HESTIA", "")
        try:
            data["uptime_min"] = int(r.get("UPTIME", 0))
        except Exception:
            pass
        # Load avg — may appear as separate cols after RELEASE
        raw = info_txt
        la_match = _re.search(r"release\s+([\d.]+)\s*/\s*([\d.]+)\s*/\s*([\d.]+)", raw, _re.IGNORECASE)
        if la_match:
            data["load1"]  = float(la_match.group(1))
            data["load5"]  = float(la_match.group(2))
            data["load15"] = float(la_match.group(3))

    # Parse sys-services
    svc_rows = _parse_hestia_table(svc_txt)
    total_mem_mb  = 0
    total_cpu_pct = 0.0
    services      = []
    for row in svc_rows:
        try:
            mem = int(row.get("MEM", 0))
            cpu = float(row.get("CPU", 0))
            total_mem_mb  += mem
            total_cpu_pct += cpu
            uptime_s = int(row.get("UPTIME", 0))
        except Exception:
            mem = 0; cpu = 0.0; uptime_s = 0
        services.append({
            "name":       row.get("NAME", ""),
            "state":      row.get("STATE", ""),
            "cpu_pct":    cpu,
            "mem_mb":     mem,
            "uptime_min": uptime_s,
        })

    data["services"]        = services
    data["total_svc_mem_mb"]= total_mem_mb
    data["total_cpu_pct"]   = round(total_cpu_pct, 2)

    # Uptime human-readable
    um = data["uptime_min"]
    d_  = um // 1440
    h_  = (um % 1440) // 60
    m_  = um % 60
    data["uptime_human"] = f"{d_}d {h_}h {m_}m" if d_ else f"{h_}h {m_}m"

    return data


@app.get("/api/vps-fisiomt/hestia/accounts")
async def api_vps_fisiomt_hestia_accounts():
    """Lista contas HestiaCP com uso de recursos."""

    async def _list_users():
        return await asyncio.get_event_loop().run_in_executor(
            None, lambda: _hestia_post("v-list-users"))

    async def _user_detail(uname: str):
        txt = await asyncio.get_event_loop().run_in_executor(
            None, lambda: _hestia_post("v-list-user", arg1=uname))
        return uname, _parse_hestia_kv(txt)

    try:
        users_txt = await _list_users()
        user_rows = _parse_hestia_table(users_txt)
        user_names = [r["USER"] for r in user_rows if r.get("USER")]

        details   = await asyncio.gather(*[_user_detail(u) for u in user_names])
        detail_map = dict(details)

        accounts = []
        for row in user_rows:
            uname = row.get("USER", "")
            d     = detail_map.get(uname, {})
            try:
                disk_mb   = int(row.get("DISK", 0))
                bw_mb     = int(row.get("BW", 0))
                web_cnt   = int(row.get("WEB", 0))
                mail_cnt  = int(row.get("MAIL", 0))
                db_cnt    = int(row.get("DB", 0))
            except Exception:
                disk_mb = bw_mb = web_cnt = mail_cnt = db_cnt = 0

            disk_quota = 0
            try:
                quota_str = d.get("DISK_QUOTA", "0").replace("unlimited", "0")
                disk_quota = int(quota_str)
            except Exception:
                pass

            disk_pct = round(disk_mb / disk_quota * 100, 1) if disk_quota > 0 else 0

            accounts.append({
                "user":        uname,
                "role":        row.get("ROLE", ""),
                "plan":        row.get("PKG", ""),
                "status":      row.get("SPND", "no"),
                "full_name":   d.get("FULL NAME", d.get("NAME", "")),
                "email":       d.get("EMAIL", ""),
                "web":         web_cnt,
                "mail":        mail_cnt,
                "db":          db_cnt,
                "disk_mb":     disk_mb,
                "disk_quota":  disk_quota,
                "disk_pct":    disk_pct,
                "bandwidth_mb":bw_mb,
                "date":        row.get("DATE", ""),
            })

        return {
            "accounts":  accounts,
            "total":     len(accounts),
            "timestamp": datetime.now().isoformat(),
        }

    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)


@app.get("/api/vps-fisiomt/hestia/domains/{username}")
async def api_vps_fisiomt_hestia_domains(username: str):
    """Lista domínios web de uma conta HestiaCP."""
    try:
        txt = await asyncio.get_event_loop().run_in_executor(
            None, lambda: _hestia_post("v-list-web-domains", arg1=username))
        rows = _parse_hestia_table(txt)
        return {"domains": rows, "user": username}
    except Exception as exc:
        return JSONResponse({"error": str(exc)}, status_code=503)



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
