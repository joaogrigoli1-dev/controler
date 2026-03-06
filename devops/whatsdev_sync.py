"""
Atualizar WhatsDev — Sincroniza tabelas WhatsApp de Produção → Dev Local
=========================================================================
Copia whatsapp_conversations e whatsapp_messages do banco myclinicsoft
de PRODUÇÃO para o banco myclinicsoft LOCAL.

SEGURANÇA:
- Direção ÚNICA: Prod → Local (nunca o contrário)
- O deploy Controler EXCLUI essas tabelas do DB sync (--exclude-table),
  portanto dados locais NUNCA sobrescrevem prod.
- O banco 'whatsapp' (Buffer interno) NÃO é tocado.

NOTA TÉCNICA: pg_dump é executado via SSH pipe direto para arquivo local
(não via ssh_command) para evitar o limite de 5000 chars do execute_command.
"""

import os
from datetime import datetime
from core.tools import execute_command, ssh_command

LOCAL_PATH  = "/Users/jhgm/Documents/DEV/myclinicsoft"
SERVER_IP   = "62.72.63.18"
SSH_KEY     = os.path.expanduser("~/.ssh/coolify_server")
SSH_OPTS    = f"-i {SSH_KEY} -o StrictHostKeyChecking=no -o ConnectTimeout=10"
SSH_PREFIX  = f"ssh {SSH_OPTS} root@{SERVER_IP}"

PG_ENV      = "PGPASSWORD='mc_pg_2026_secure'"
PG_CONN     = "-U myclinicsoft -h 127.0.0.1 -d myclinicsoft"
# Inclui ambos os nomes (prod pode ter nome PT ou EN dependendo do estado da migração)
PG_TABLES   = "-t whatsapp_conversations -t whatsapp_messages -t whatsapp_mensagens"

PSQL_CANDIDATES = [
    "/opt/homebrew/Cellar/postgresql@16/16.12/bin/psql",
    "/opt/homebrew/Cellar/postgresql@15/15.16/bin/psql",
    "/opt/homebrew/bin/psql",
    "/usr/local/bin/psql",
    "psql",
]


def _find_psql():
    for c in PSQL_CANDIDATES:
        r = execute_command(f'test -x "{c}" && echo OK', timeout=5)
        if r.get("stdout", "").strip() == "OK":
            return c
    return "psql"


def _get_local_db_url():
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


def _ssh_pipe_to_file(remote_cmd: str, local_file: str, timeout: int = 60) -> dict:
    """
    Executa remote_cmd via SSH e redireciona stdout direto para local_file.
    Evita o limite de 5000 chars do execute_command ao não capturar o output.
    """
    cmd = f'{SSH_PREFIX} "{remote_cmd}" > {local_file} 2>/tmp/whatsdev_err.txt'
    r = execute_command(cmd, timeout=timeout)
    # Verifica se arquivo foi criado e tem conteúdo
    size_r = execute_command(f'wc -c < "{local_file}" 2>/dev/null || echo 0', timeout=5)
    size = int(size_r.get("stdout", "0").strip() or "0")
    err_r = execute_command(f'cat /tmp/whatsdev_err.txt 2>/dev/null || echo ""', timeout=5)
    stderr = err_r.get("stdout", "").strip()
    return {
        "success": r["success"] and size > 0,
        "size": size,
        "stderr": stderr,
        "exit_code": r.get("exit_code", -1)
    }


async def sync(log_callback=None):
    """
    Sincroniza whatsapp_conversations e whatsapp_messages de Prod → Dev Local.
    log_callback(entry) — para atualizar interface em tempo real.
    """
    logs = []
    started = datetime.now()

    def log(step, status, msg):
        entry = {"step": step, "status": status, "message": msg, "time": datetime.now().isoformat()}
        logs.append(entry)
        if log_callback:
            log_callback(entry)

    DUMP_LOCAL   = "/tmp/whatsapp_dev_data.sql"
    SCHEMA_LOCAL = "/tmp/whatsapp_dev_schema.sql"

    # ── 1: Verifica SSH ──
    log("ssh", "running", f"Testando conexão SSH com {SERVER_IP}...")
    r = ssh_command("echo ok", timeout=10)
    if not r["success"] or "ok" not in r.get("stdout", ""):
        log("ssh", "error", f"Sem acesso SSH ao servidor {SERVER_IP}")
        return {"success": False, "logs": logs, "error": "SSH inacessível"}
    log("ssh", "ok", f"SSH OK → {SERVER_IP}")

    # ── 2: pg_dump schema via SSH pipe → arquivo local ──
    log("schema", "running", "Extraindo schema das tabelas WhatsApp do prod...")
    r = _ssh_pipe_to_file(
        f"{PG_ENV} pg_dump {PG_CONN} {PG_TABLES} --schema-only --no-owner --no-acl",
        SCHEMA_LOCAL,
        timeout=30
    )
    if not r["success"]:
        err_detail = r.get("stderr", "") or f"arquivo vazio (exit {r.get('exit_code')})"
        log("schema", "error", f"pg_dump schema falhou: {err_detail[:300]}")
        return {"success": False, "logs": logs, "error": "pg_dump schema falhou"}
    # Remover linhas \restrict / \unrestrict (meta-comandos do psql do prod
    # que o psql homebrew não reconhece e causam erro de sintaxe)
    execute_command(
        f"sed '/^\\\\\\\\restrict /d;/^\\\\\\\\unrestrict /d' \"{SCHEMA_LOCAL}\" > \"{SCHEMA_LOCAL}.clean\" && mv \"{SCHEMA_LOCAL}.clean\" \"{SCHEMA_LOCAL}\"",
        timeout=10
    )
    log("schema", "ok", f"Schema extraído ({r['size']} bytes)")

    # ── 3: pg_dump dados via SSH pipe → arquivo local ──
    log("dump", "running", "Extraindo dados de prod (conversations + messages)...")
    r = _ssh_pipe_to_file(
        f"{PG_ENV} pg_dump {PG_CONN} {PG_TABLES} --data-only --no-owner --no-acl",
        DUMP_LOCAL,
        timeout=60
    )
    if not r["success"]:
        err_detail = r.get("stderr", "") or f"arquivo vazio (exit {r.get('exit_code')})"
        log("dump", "error", f"pg_dump dados falhou: {err_detail[:300]}")
        return {"success": False, "logs": logs, "error": "pg_dump dados falhou"}
    # Remover linhas \restrict / \unrestrict do dump de dados também
    execute_command(
        f"sed '/^\\\\\\\\restrict /d;/^\\\\\\\\unrestrict /d' \"{DUMP_LOCAL}\" > \"{DUMP_LOCAL}.clean\" && mv \"{DUMP_LOCAL}.clean\" \"{DUMP_LOCAL}\"",
        timeout=10
    )
    # Conta linhas do dump para log
    lines_r = execute_command(f'wc -l < "{DUMP_LOCAL}"', timeout=5)
    lines = lines_r.get("stdout", "?").strip()
    log("dump", "ok", f"Dump extraído ({r['size']} bytes, ~{lines} linhas)")

    # ── 4: Localiza psql e DATABASE_URL ──
    psql = _find_psql()
    local_url = _get_local_db_url()
    if not local_url:
        log("restore", "error", "DATABASE_URL não encontrada no .env local")
        return {"success": False, "logs": logs, "error": "DATABASE_URL ausente"}

    psql_cmd = f'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" "{psql}"'

    # ── 5: Aplica schema localmente (IF NOT EXISTS — seguro de repetir) ──
    log("restore", "running", "Criando tabelas locais se necessário...")
    execute_command(
        f'{psql_cmd} "{local_url}" -f "{SCHEMA_LOCAL}" 2>&1 | grep -vE "already exists|NOTICE" || true',
        timeout=30
    )

    # ── 6: Apaga dados locais (ordem FK — limpa ambos nomes PT e EN) ──
    # Prod pode ter 'whatsapp_mensagens' (PT) ou 'whatsapp_messages' (EN) dependendo
    # do estado da migração. Limpamos ambos para garantir restore sem duplicate key.
    log("restore", "running", "Limpando dados locais anteriores (PT + EN names)...")
    execute_command(
        f'{psql_cmd} "{local_url}" -c "'
        f'DO $$ BEGIN '
        f'  DELETE FROM whatsapp_messages; '
        f'EXCEPTION WHEN undefined_table THEN NULL; END; $$; '
        f'DO $$ BEGIN '
        f'  DELETE FROM whatsapp_mensagens; '
        f'EXCEPTION WHEN undefined_table THEN NULL; END; $$; '
        f'DO $$ BEGIN '
        f'  DELETE FROM whatsapp_conversations; '
        f'EXCEPTION WHEN undefined_table THEN NULL; END; $$;" 2>&1',
        timeout=15
    )

    # ── 7: Restaura dados ──
    log("restore", "running", "Restaurando dados no banco local...")
    r = execute_command(
        f'{psql_cmd} "{local_url}" -f "{DUMP_LOCAL}" 2>&1',
        timeout=60
    )
    output = r.get("stdout", "") + r.get("stderr", "")
    errors = [l for l in output.split("\n") if "ERROR" in l and "does not exist" not in l]
    if errors:
        log("restore", "error", "Erros na restauração:\n" + "\n".join(errors[:5]))
        return {"success": False, "logs": logs, "error": "Restauração com erros"}

    # ── 8: Contagens finais ──
    r_conv = execute_command(
        f'{psql_cmd} "{local_url}" -t -c "SELECT COUNT(*) FROM whatsapp_conversations;" 2>&1',
        timeout=10
    )
    r_msg = execute_command(
        f'{psql_cmd} "{local_url}" -t -c "SELECT COUNT(*) FROM whatsapp_messages;" 2>&1',
        timeout=10
    )
    conv_count = r_conv.get("stdout", "").strip() if r_conv["success"] else "?"
    msg_count  = r_msg.get("stdout",  "").strip() if r_msg["success"]  else "?"

    # Limpeza
    execute_command(f'rm -f "{DUMP_LOCAL}" "{SCHEMA_LOCAL}" /tmp/whatsdev_err.txt')

    elapsed = (datetime.now() - started).total_seconds()
    log("done", "ok",
        f"✅ Sync concluído em {elapsed:.0f}s  |  "
        f"conversas: {conv_count}  |  mensagens: {msg_count}\n"
        f"⚠️  Mensagens novas após esta sync não aparecem automaticamente — repita quando necessário.")

    return {
        "success": True, "logs": logs, "elapsed_seconds": elapsed,
        "conversations": conv_count, "messages": msg_count
    }
