"""
Controler — Ferramentas do Agente
==================================
Define as ferramentas que o agente IA pode usar.
Cada ferramenta executa no Mac real com acesso total.
"""

import subprocess
import os
import json
from pathlib import Path


def execute_command(command: str, cwd: str = None, timeout: int = 120) -> dict:
    """
    Executa um comando shell no Mac.
    O agente pode rodar qualquer coisa: npm, git, ssh, curl, python, etc.
    """
    try:
        result = subprocess.run(
            command, shell=True, cwd=cwd,
            capture_output=True, text=True, timeout=timeout
        )
        return {
            "success": result.returncode == 0,
            "exit_code": result.returncode,
            "stdout": result.stdout[-5000:] if len(result.stdout) > 5000 else result.stdout,
            "stderr": result.stderr[-2000:] if len(result.stderr) > 2000 else result.stderr
        }
    except subprocess.TimeoutExpired:
        return {"success": False, "exit_code": -1, "stdout": "", "stderr": f"Timeout após {timeout}s"}
    except Exception as e:
        return {"success": False, "exit_code": -1, "stdout": "", "stderr": str(e)}


def read_file(path: str, max_lines: int = 500) -> dict:
    """Lê conteúdo de um arquivo."""
    try:
        p = Path(path).expanduser()
        if not p.exists():
            return {"success": False, "error": f"Arquivo não encontrado: {path}"}
        if not p.is_file():
            return {"success": False, "error": f"Não é um arquivo: {path}"}

        content = p.read_text(encoding='utf-8', errors='replace')
        lines = content.split('\n')
        truncated = len(lines) > max_lines

        if truncated:
            content = '\n'.join(lines[:max_lines]) + f"\n\n... [truncado: {len(lines)} linhas total]"

        return {
            "success": True,
            "path": str(p),
            "content": content,
            "lines": len(lines),
            "truncated": truncated
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


def write_file(path: str, content: str) -> dict:
    """Escreve conteúdo em um arquivo."""
    try:
        p = Path(path).expanduser()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content, encoding='utf-8')
        return {"success": True, "path": str(p), "size": len(content)}
    except Exception as e:
        return {"success": False, "error": str(e)}


def list_directory(path: str) -> dict:
    """Lista conteúdo de um diretório."""
    try:
        p = Path(path).expanduser()
        if not p.exists():
            return {"success": False, "error": f"Diretório não encontrado: {path}"}

        items = []
        for item in sorted(p.iterdir()):
            items.append({
                "name": item.name,
                "type": "dir" if item.is_dir() else "file",
                "size": item.stat().st_size if item.is_file() else None
            })

        return {"success": True, "path": str(p), "items": items[:200]}
    except Exception as e:
        return {"success": False, "error": str(e)}


def ssh_command(command: str, host: str = "62.72.63.18", user: str = "root",
                key: str = "~/.ssh/coolify_server", timeout: int = 30) -> dict:
    """Executa comando via SSH no servidor remoto."""
    key_path = os.path.expanduser(key)
    ssh_opts = f"-i {key_path} -o StrictHostKeyChecking=no -o ConnectTimeout=10"
    full_cmd = f'ssh {ssh_opts} {user}@{host} "{command}"'
    return execute_command(full_cmd, timeout=timeout)


# ── Definições das ferramentas para a API Anthropic ──

TOOL_DEFINITIONS = [
    {
        "name": "execute_command",
        "description": "Executa um comando no terminal do Mac. Tem acesso total: npm, git, ssh, curl, python, node, make, etc. Use para qualquer operação no sistema.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "O comando shell a executar"
                },
                "cwd": {
                    "type": "string",
                    "description": "Diretório de trabalho (opcional). Ex: /Users/jhgm/Documents/DEV/myclinicsoft"
                },
                "timeout": {
                    "type": "integer",
                    "description": "Timeout em segundos (padrão: 120)",
                    "default": 120
                }
            },
            "required": ["command"]
        }
    },
    {
        "name": "read_file",
        "description": "Lê o conteúdo de um arquivo no Mac. Retorna o texto do arquivo.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Caminho absoluto do arquivo. Ex: /Users/jhgm/Documents/DEV/myclinicsoft/package.json"
                },
                "max_lines": {
                    "type": "integer",
                    "description": "Máximo de linhas a ler (padrão: 500)",
                    "default": 500
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "write_file",
        "description": "Escreve conteúdo em um arquivo no Mac. Cria diretórios se necessário.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Caminho absoluto do arquivo"
                },
                "content": {
                    "type": "string",
                    "description": "Conteúdo a escrever"
                }
            },
            "required": ["path", "content"]
        }
    },
    {
        "name": "list_directory",
        "description": "Lista arquivos e pastas de um diretório.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Caminho do diretório"
                }
            },
            "required": ["path"]
        }
    },
    {
        "name": "ssh_command",
        "description": "Executa comando via SSH no servidor de produção (62.72.63.18 — Coolify/srv1). ATENÇÃO: respeitar regra de direção única — comandos de leitura/diagnóstico apenas, nunca alterar dados ou código diretamente no servidor.",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Comando a executar no servidor remoto"
                },
                "host": {
                    "type": "string",
                    "description": "IP do servidor (padrão: 62.72.63.18)",
                    "default": "62.72.63.18"
                }
            },
            "required": ["command"]
        }
    },
    {
        "name": "coolify_api",
        "description": "Faz requisição para a Coolify API (62.72.63.18:8000). Permite gerenciar deploys, verificar status de aplicações, e executar operações no servidor Coolify.",
        "input_schema": {
            "type": "object",
            "properties": {
                "method": {
                    "type": "string",
                    "description": "Método HTTP: GET, POST, PUT, DELETE",
                    "default": "GET"
                },
                "path": {
                    "type": "string",
                    "description": "Caminho da API (ex: /applications/UUID, /applications/UUID/restart)"
                }
            },
            "required": ["path"]
        }
    }
]


# ── Executor: recebe o tool_use da API e executa ──

def coolify_api(path: str, method: str = "GET") -> dict:
    """Faz requisição para a Coolify API."""
    import urllib.request
    import urllib.error
    COOLIFY_URL = os.getenv("COOLIFY_URL", "http://62.72.63.18:8000")
    COOLIFY_TOKEN = os.getenv("COOLIFY_TOKEN", "")
    url = f"{COOLIFY_URL}/api/v1{path}"
    headers = {
        "Authorization": f"Bearer {COOLIFY_TOKEN}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    req = urllib.request.Request(url, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read().decode()
            return {"success": True, "status": resp.status, "data": json.loads(data) if data else {}}
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:500]
        except Exception:
            pass
        return {"success": False, "status": e.code, "error": f"HTTP {e.code}: {body}"}
    except Exception as e:
        return {"success": False, "error": str(e)[:300]}


TOOL_EXECUTORS = {
    "execute_command": lambda args: execute_command(
        args["command"], args.get("cwd"), args.get("timeout", 120)
    ),
    "read_file": lambda args: read_file(
        args["path"], args.get("max_lines", 500)
    ),
    "write_file": lambda args: write_file(
        args["path"], args["content"]
    ),
    "list_directory": lambda args: list_directory(
        args["path"]
    ),
    "ssh_command": lambda args: ssh_command(
        args["command"], args.get("host", "62.72.63.18")
    ),
    "coolify_api": lambda args: coolify_api(
        args["path"], args.get("method", "GET")
    ),
}


def execute_tool(tool_name: str, tool_input: dict) -> str:
    """Executa uma ferramenta e retorna o resultado como string JSON."""
    executor = TOOL_EXECUTORS.get(tool_name)
    if not executor:
        return json.dumps({"error": f"Ferramenta desconhecida: {tool_name}"})

    result = executor(tool_input)
    return json.dumps(result, ensure_ascii=False, default=str)
