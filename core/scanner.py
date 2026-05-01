"""
core/scanner.py — Resource Scanner do Controler v3
===================================================
Detecta recursos desperdiçados ou problemáticos na infraestrutura:

  1. Containers parados
  2. Docker images dangling (orphan)
  3. Docker volumes sem uso (dangling)
  4. Git branches antigas (> 30 dias sem commit, merged em main)
  5. Parâmetros SSM sem referência no código
  6. Cron jobs com alta taxa de erro (tabela timeline_events)

Resultado estruturado com severidade + ação sugerida + flag action_safe.
"""

import asyncio
import json
import logging
import subprocess
from datetime import datetime, timedelta
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# ── Constantes ───────────────────────────────────────────────────────────────
DOCKER_SOCKET = "http+unix://%2Fvar%2Frun%2Fdocker.sock"
STOPPED_DAYS_WARN = 7    # containers parados há > 7 dias → WARNING (senão INFO)
BRANCH_STALE_DAYS = 30   # branches sem commit há > 30 dias
CRON_ERROR_THRESH = 0.90 # > 90% erro nos últimos 30 dias → WARNING

# Whitelist de comandos que podem ser executados automaticamente
SAFE_COMMANDS_WHITELIST = {
    "docker image prune -f",
    "docker volume prune -f",
}


# ── Docker socket helpers ────────────────────────────────────────────────────

async def _docker_get(path: str) -> dict | list:
    """GET request via Docker Unix socket."""
    try:
        async with httpx.AsyncClient(
            base_url=DOCKER_SOCKET,
            transport=httpx.AsyncHTTPTransport(uds="/var/run/docker.sock"),
            timeout=10.0,
        ) as client:
            r = await client.get(path)
            r.raise_for_status()
            return r.json()
    except httpx.ConnectError:
        raise RuntimeError("Docker socket não acessível em /var/run/docker.sock")
    except Exception as exc:
        raise RuntimeError(f"Docker API error ({path}): {exc}")


# ── Category scanners ────────────────────────────────────────────────────────

async def scan_stopped_containers() -> list[dict]:
    """Detecta containers com state != running."""
    issues = []
    try:
        containers = await _docker_get("/containers/json?all=true")
        now = datetime.now()
        for c in containers:
            state = c.get("State", "")
            if state == "running":
                continue

            name = (c.get("Names") or ["?"])[0].lstrip("/")
            image = c.get("Image", "?")

            # Calcular tempo parado a partir de FinishedAt
            finished_at = None
            days_stopped = 0
            created_ts = c.get("Created", 0)
            if created_ts:
                try:
                    finished_at = datetime.fromtimestamp(created_ts)
                    days_stopped = (now - finished_at).days
                except Exception:
                    pass

            severity = "warning" if days_stopped > STOPPED_DAYS_WARN else "info"
            issues.append({
                "category":    "containers",
                "severity":    severity,
                "title":       f"Container parado: {name}",
                "description": f"Estado: {state} · Imagem: {image} · Parado há ~{days_stopped} dias",
                "action":      f"docker rm {c.get('Id', '')[:12]}",
                "action_safe": False,  # Não seguro automaticamente — pode ter dados
                "metadata": {
                    "container_id":    c.get("Id", "")[:12],
                    "container_name":  name,
                    "image":           image,
                    "state":           state,
                    "days_stopped":    days_stopped,
                },
            })
    except RuntimeError as exc:
        logger.warning(f"scan_stopped_containers: {exc}")
    return issues


async def scan_dangling_images() -> list[dict]:
    """Detecta Docker images dangling (sem tag, sem container)."""
    issues = []
    try:
        images = await _docker_get('/images/json?filters={"dangling":["true"]}')
        if not images:
            return []

        total_mb = sum(img.get("Size", 0) for img in images) / (1024 * 1024)
        issues.append({
            "category":    "images",
            "severity":    "warning" if total_mb > 100 else "info",
            "title":       f"{len(images)} image(s) dangling ({total_mb:.0f} MB)",
            "description": "Imagens Docker sem tag e sem container vinculado. Podem ser removidas com segurança.",
            "action":      "docker image prune -f",
            "action_safe": True,
            "metadata": {
                "count":    len(images),
                "total_mb": round(total_mb, 1),
            },
        })
    except RuntimeError as exc:
        logger.warning(f"scan_dangling_images: {exc}")
    return issues


async def scan_dangling_volumes() -> list[dict]:
    """Detecta Docker volumes sem uso (dangling)."""
    issues = []
    try:
        data = await _docker_get('/volumes?filters={"dangling":["true"]}')
        volumes = data.get("Volumes") or []
        if not volumes:
            return []

        names = [v.get("Name", "?") for v in volumes[:5]]
        extra = len(volumes) - 5 if len(volumes) > 5 else 0
        desc = ", ".join(names) + (f" +{extra} mais" if extra else "")

        issues.append({
            "category":    "volumes",
            "severity":    "info",
            "title":       f"{len(volumes)} volume(s) sem uso",
            "description": f"Volumes: {desc}",
            "action":      "docker volume prune -f",
            "action_safe": True,
            "metadata": {
                "count":   len(volumes),
                "volumes": [v.get("Name") for v in volumes],
            },
        })
    except RuntimeError as exc:
        logger.warning(f"scan_dangling_volumes: {exc}")
    return issues


def _scan_git_branches_sync(projects_path: Path) -> list[dict]:
    """Detecta branches antigas em todos os projetos (síncrono, roda em thread)."""
    issues = []
    cutoff = datetime.now() - timedelta(days=BRANCH_STALE_DAYS)

    for project_dir in projects_path.iterdir():
        if not project_dir.is_dir():
            continue
        git_dir = project_dir / ".git"
        if not git_dir.exists():
            continue

        try:
            # Listar branches remotas merged em main
            r = subprocess.run(
                ["git", "-C", str(project_dir), "branch", "-r", "--merged", "origin/main"],
                capture_output=True, text=True, timeout=15,
            )
            if r.returncode != 0:
                continue

            merged_branches = [
                b.strip().replace("origin/", "")
                for b in r.stdout.splitlines()
                if b.strip() and "origin/main" not in b and "HEAD" not in b
            ]

            for branch in merged_branches:
                # Verificar data do último commit nessa branch
                r2 = subprocess.run(
                    ["git", "-C", str(project_dir), "log", "-1",
                     "--format=%ci", f"origin/{branch}"],
                    capture_output=True, text=True, timeout=10,
                )
                if r2.returncode != 0 or not r2.stdout.strip():
                    continue

                try:
                    last_commit_str = r2.stdout.strip()[:19]
                    last_commit = datetime.strptime(last_commit_str, "%Y-%m-%d %H:%M:%S")
                except Exception:
                    continue

                if last_commit < cutoff:
                    days_old = (datetime.now() - last_commit).days
                    issues.append({
                        "category":    "git_branches",
                        "severity":    "info",
                        "title":       f"Branch antiga: {project_dir.name}/{branch}",
                        "description": f"Merged em main há {days_old} dias. Pode ser removida.",
                        "action":      f"git -C {project_dir} push origin --delete {branch}",
                        "action_safe": False,
                        "metadata": {
                            "project":     project_dir.name,
                            "branch":      branch,
                            "days_old":    days_old,
                            "last_commit": last_commit.isoformat(),
                        },
                    })
        except subprocess.TimeoutExpired:
            logger.warning(f"scan_git_branches: timeout em {project_dir.name}")
        except Exception as exc:
            logger.warning(f"scan_git_branches({project_dir.name}): {exc}")

    return issues


async def scan_git_branches(projects_path: Path) -> list[dict]:
    """Wrapper async para o scan de branches (roda em thread para não bloquear)."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _scan_git_branches_sync, projects_path)


def _get_code_ssm_refs() -> set[str]:
    """Extrai referências a parâmetros SSM no código-fonte de controler.py."""
    refs = set()
    try:
        src_file = Path(__file__).parent.parent / "controler.py"
        if not src_file.exists():
            return refs
        content = src_file.read_text(errors="replace")
        import re
        # Captura: get_ssm_param("/controler/xxx") e similar
        matches = re.findall(r'get_ssm_param\(["\']([^"\']+)["\']', content)
        refs.update(matches)
        # Também captura strings que parecem paths SSM
        matches2 = re.findall(r'"(/(?:controler|myclinicsoft|libertakidz)/[^"]+)"', content)
        refs.update(matches2)
    except Exception as exc:
        logger.warning(f"_get_code_ssm_refs: {exc}")
    return refs


async def scan_ssm_params() -> list[dict]:
    """Detecta parâmetros SSM /controler/* que não aparecem no código."""
    issues = []
    try:
        from core.ssm import get_ssm_param
        from core.database import get_db_conn

        # Tentar listar parâmetros do SSM via AWS SDK
        try:
            import boto3
            ssm = boto3.client("ssm", region_name="us-east-1")
            paginator = ssm.get_paginator("describe_parameters")
            all_params = []
            for page in paginator.paginate(
                ParameterFilters=[{"Key": "Path", "Option": "Recursive", "Values": ["/controler"]}]
            ):
                all_params.extend(page.get("Parameters", []))

            code_refs = _get_code_ssm_refs()
            for p in all_params:
                name = p.get("Name", "")
                if name not in code_refs:
                    issues.append({
                        "category":    "ssm_params",
                        "severity":    "info",
                        "title":       f"SSM param sem referência: {name}",
                        "description": "Parâmetro existe no SSM mas não é referenciado no código. Verificar se ainda é necessário.",
                        "action":      f"aws ssm delete-parameter --name '{name}'",
                        "action_safe": False,
                        "metadata": {
                            "name":          name,
                            "type":          p.get("Type", "?"),
                            "last_modified": p.get("LastModifiedDate", ""),
                        },
                    })
        except ImportError:
            logger.info("boto3 não disponível — scan_ssm_params ignorado")
        except Exception as exc:
            logger.warning(f"scan_ssm_params AWS: {exc}")
    except Exception as exc:
        logger.warning(f"scan_ssm_params: {exc}")
    return issues


async def scan_failing_crons() -> list[dict]:
    """Detecta cron jobs com alta taxa de erro no SQLite (timeline_events)."""
    issues = []
    try:
        from core.database import get_db_conn
        with get_db_conn() as conn:
            rows = conn.execute("""
                SELECT
                    title,
                    COUNT(*) AS total,
                    SUM(CASE WHEN severity = 'error' THEN 1 ELSE 0 END) AS errors
                FROM timeline_events
                WHERE event_type = 'scheduler'
                  AND ts > datetime('now', '-30 days')
                GROUP BY title
                HAVING total >= 5
            """).fetchall()

            for row in rows:
                title, total, errors = row
                error_rate = (errors / total) if total > 0 else 0
                if error_rate >= CRON_ERROR_THRESH:
                    issues.append({
                        "category":    "cron_jobs",
                        "severity":    "warning",
                        "title":       f"Cron com falhas: {title}",
                        "description": f"{errors}/{total} execuções falharam ({error_rate:.0%}) nos últimos 30 dias.",
                        "action":      f"Verificar logs do job '{title}' e corrigir a causa raiz.",
                        "action_safe": False,
                        "metadata": {
                            "job_title":  title,
                            "total_runs": total,
                            "errors":     errors,
                            "error_rate": round(error_rate, 3),
                        },
                    })
    except Exception as exc:
        logger.warning(f"scan_failing_crons: {exc}")
    return issues


# ── Main scan orchestrator ───────────────────────────────────────────────────

async def run_scan(projects_path: Path | None = None) -> dict:
    """
    Executa o scan completo em paralelo.
    Retorna resultado estruturado com todos os issues e summary.
    """
    if projects_path is None:
        # Import aqui para evitar circular import com controler.py
        try:
            import os
            projects_path = Path(os.getenv("PROJECTS_PATH", str(Path.home() / "Documents" / "DEV")))
        except Exception:
            projects_path = Path.home() / "Documents" / "DEV"

    logger.info("Resource Scanner iniciado")
    started = datetime.now()

    # Executar todos os scanners em paralelo
    results = await asyncio.gather(
        scan_stopped_containers(),
        scan_dangling_images(),
        scan_dangling_volumes(),
        scan_git_branches(projects_path),
        scan_ssm_params(),
        scan_failing_crons(),
        return_exceptions=True,
    )

    all_issues: list[dict] = []
    for result in results:
        if isinstance(result, Exception):
            logger.error(f"Scanner error: {result}")
        elif isinstance(result, list):
            all_issues.extend(result)

    # Agrupar por categoria para o frontend
    grouped: dict[str, list] = {}
    for issue in all_issues:
        cat = issue.get("category", "other")
        if cat not in grouped:
            grouped[cat] = {"issues": [], "count": 0}
        grouped[cat]["issues"].append(issue)
        grouped[cat]["count"] += 1

    # Summary
    counts = {"critical": 0, "warning": 0, "info": 0}
    for issue in all_issues:
        sev = issue.get("severity", "info")
        counts[sev] = counts.get(sev, 0) + 1

    elapsed = (datetime.now() - started).total_seconds()
    logger.info(f"Resource Scanner concluído em {elapsed:.1f}s — {len(all_issues)} issues encontrados")

    return {
        "scanned_at": started.isoformat(),
        "elapsed_sec": round(elapsed, 2),
        "items": all_issues,
        "results": grouped,  # formato esperado pelo frontend
        "summary": {
            "critical": counts.get("critical", 0),
            "warning":  counts.get("warning", 0),
            "info":     counts.get("info", 0),
            "total":    len(all_issues),
        },
    }


# ── Safe command executor ────────────────────────────────────────────────────

def execute_safe_action(action: str) -> dict:
    """
    Executa um comando da whitelist de ações seguras.
    NUNCA executar comandos arbitrários — apenas os da SAFE_COMMANDS_WHITELIST.
    """
    if action not in SAFE_COMMANDS_WHITELIST:
        return {
            "executed": False,
            "output": "",
            "error": f"Comando não está na whitelist de ações seguras: '{action}'",
        }

    try:
        result = subprocess.run(
            action.split(),
            capture_output=True,
            text=True,
            timeout=30,
        )
        return {
            "executed": True,
            "output": result.stdout.strip(),
            "error": result.stderr.strip() if result.returncode != 0 else "",
            "returncode": result.returncode,
        }
    except subprocess.TimeoutExpired:
        return {"executed": False, "output": "", "error": "Timeout após 30s"}
    except Exception as exc:
        return {"executed": False, "output": "", "error": str(exc)}
