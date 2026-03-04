"""
Controler — Agente IA (Motor Claude CLI)
==========================================
Usa o Claude Code CLI (plano Max) em vez da API paga.
O Claude CLI tem acesso ao shell, arquivos, web — executa direto no Mac.
"""

import json
import os
import subprocess
import uuid
from datetime import datetime
from typing import Optional

from core.database import (
    get_rules, get_memory, save_conversation,
    get_project
)

# Timeout máximo por execução (5 min)
MAX_TIMEOUT = 300

# Caminho do Claude CLI (instalado via npm global)
CLAUDE_CLI = os.environ.get(
    "CLAUDE_CLI_PATH",
    "/Users/jhgm/.npm-global/bin/claude"
)

# Modelo: CLAUDE.md exige Opus para todos os agentes
DEFAULT_MODEL = "opus"


def _build_system_prompt(project_id: Optional[str] = None) -> str:
    """Monta o system prompt com contexto do projeto, regras e memória."""

    base = """Você é o agente operacional do Controler — um assistente com acesso total ao Mac do João Henrique.
Você pode executar comandos no terminal, ler e escrever arquivos, e acessar servidores via SSH.

REGRAS FUNDAMENTAIS:
- Você é um executor. Quando o João pede algo, faça — não fique pedindo confirmação desnecessária.
- Sempre respeite as regras do projeto carregadas abaixo.
- Para o MyClinicSoft: o caminho de código é SEMPRE Local → GitHub → Produção. NUNCA o inverso.
- O WhatsApp Buffer (porta 3001) é CRÍTICO e NUNCA pode ser derrubado ou sobrescrito.
- Respostas devem ser diretas e em português.
- Ao executar comandos, mostre o que fez e o resultado.
- Para SSH no servidor de produção: ssh -i ~/.ssh/coolify_server -o StrictHostKeyChecking=no root@187.77.40.102 "comando"
- NUNCA altere dados ou código diretamente no servidor de produção.
- Projeto MyClinicSoft: /Users/jhgm/Documents/DEV/myclinicsoft
- Projeto Controler: /Users/jhgm/Documents/DEV/controler
"""

    if project_id:
        project = get_project(project_id)
        if project:
            base += f"\n\n--- PROJETO ATIVO: {project['name']} ---\n{project.get('description', '')}\n"

        # Carregar regras do banco
        rules = get_rules(project_id)
        if rules:
            base += "\n\n--- REGRAS DO PROJETO (OBRIGATÓRIAS) ---\n"
            for r in rules:
                severity_icon = {"mandatory": "🔴", "warning": "🟡", "info": "🔵"}.get(r['severity'], '•')
                base += f"\n{severity_icon} [{r['category'].upper()}] {r['title']}\n{r['content']}\n"

        # Carregar memória
        memory = get_memory(project_id)
        if memory:
            mem_content = memory['content'][:3000]
            base += f"\n\n--- MEMÓRIA DO PROJETO (v{memory['version']}) ---\n{mem_content}\n"

    return base


def _check_cli_available() -> bool:
    """Verifica se o Claude CLI está instalado e autenticado."""
    try:
        result = subprocess.run(
            [CLAUDE_CLI, "auth", "status"],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            return data.get("loggedIn", False)
    except Exception:
        pass
    return False


async def chat(message: str, conversation_history: list = None,
               project_id: Optional[str] = None,
               cli_session_id: Optional[str] = None) -> dict:
    """
    Processa uma mensagem do usuário via Claude Code CLI (plano Max).

    O Claude CLI gerencia suas próprias ferramentas internamente:
    - Bash (terminal completo)
    - Read/Write/Edit (arquivos)
    - Glob/Grep (busca)
    - WebSearch/WebFetch (web)

    Retorna: {"response": str, "messages": list, "tool_calls": list,
              "cli_session_id": str, "cost_usd": float, "num_turns": int}
    """

    new_session_id = cli_session_id or str(uuid.uuid4())

    try:
        # Verificar se CLI está disponível
        if not _check_cli_available():
            return {
                "response": (
                    "⚠️ Claude CLI não está disponível ou não autenticado.\n"
                    "Execute no terminal: claude auth login"
                ),
                "messages": [],
                "tool_calls": [],
                "cli_session_id": None
            }

        system_prompt = _build_system_prompt(project_id)

        # Montar comando CLI
        cmd = [CLAUDE_CLI, "-p"]  # Print mode (não-interativo)
        cmd += ["--output-format", "json"]
        cmd += ["--dangerously-skip-permissions"]
        cmd += ["--model", DEFAULT_MODEL]

        if cli_session_id:
            # Continuar sessão existente
            cmd += ["--resume", cli_session_id]
        else:
            # Nova sessão — incluir system prompt
            cmd += ["--session-id", new_session_id]
            cmd += ["--system-prompt", system_prompt]

        # Adicionar diretórios com acesso
        cmd += ["--add-dir", "/Users/jhgm/Documents/DEV/myclinicsoft"]
        cmd += ["--add-dir", "/Users/jhgm/Documents/DEV/controler"]

        # Mensagem do usuário via stdin (mais robusto que argumento posicional
        # com system prompts longos)

        # Executar Claude CLI
        result = subprocess.run(
            cmd,
            input=message,
            capture_output=True,
            text=True,
            timeout=MAX_TIMEOUT,
            cwd="/Users/jhgm/Documents",
            env={**os.environ, "LANG": "pt_BR.UTF-8"}
        )

    except subprocess.TimeoutExpired:
        return {
            "response": "⚠️ Timeout: a execução ultrapassou 5 minutos.",
            "messages": [],
            "tool_calls": [],
            "cli_session_id": cli_session_id
        }
    except FileNotFoundError:
        return {
            "response": (
                "❌ Claude CLI não encontrado.\n"
                f"Caminho esperado: {CLAUDE_CLI}\n"
                "Instale com: npm install -g @anthropic-ai/claude-code"
            ),
            "messages": [],
            "tool_calls": [],
            "cli_session_id": None
        }
    except Exception as e:
        return {
            "response": f"❌ Erro ao executar Claude CLI: {str(e)}",
            "messages": [],
            "tool_calls": [],
            "cli_session_id": cli_session_id
        }

    # Processar resultado
    try:
        if result.returncode != 0:
            error_msg = result.stderr.strip() or result.stdout.strip() or "Erro desconhecido"
            return {
                "response": f"❌ Claude CLI retornou erro:\n{error_msg[:1000]}",
                "messages": [],
                "tool_calls": [],
                "cli_session_id": cli_session_id
            }

        # Parse JSON output do CLI
        output = json.loads(result.stdout)

        response_text = output.get("result", "")
        session_id = output.get("session_id", cli_session_id or new_session_id)
        cost_usd = output.get("total_cost_usd", 0)
        num_turns = output.get("num_turns", 1)
        duration_ms = output.get("duration_ms", 0)

        # Montar histórico simplificado para salvar no banco
        messages = conversation_history or []
        messages.append({"role": "user", "content": message})
        messages.append({
            "role": "assistant",
            "content": response_text,
            "metadata": {
                "cli_session_id": session_id,
                "cost_usd": cost_usd,
                "num_turns": num_turns,
                "duration_ms": duration_ms,
                "model": output.get("modelUsage", {})
            }
        })

        # Salvar conversa no banco
        if project_id:
            title = message[:60] + "..." if len(message) > 60 else message
            save_conversation(project_id, title, messages)

        return {
            "response": response_text,
            "messages": messages,
            "tool_calls": [],  # CLI gerencia tools internamente
            "cli_session_id": session_id,
            "cost_usd": cost_usd,
            "num_turns": num_turns,
            "duration_ms": duration_ms
        }

    except json.JSONDecodeError:
        # Se não for JSON, o CLI retornou texto puro (pode acontecer com erros)
        text_output = result.stdout.strip()
        return {
            "response": text_output or "Sem resposta do CLI.",
            "messages": [],
            "tool_calls": [],
            "cli_session_id": cli_session_id
        }
    except Exception as e:
        return {
            "response": f"❌ Erro ao processar resposta: {str(e)}",
            "messages": [],
            "tool_calls": [],
            "cli_session_id": cli_session_id
        }
