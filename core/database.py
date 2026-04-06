"""
Controler — Banco de Dados SQLite
==================================
Persistência local em controler/bd/controler.db
Sobrevive a reinícios da máquina. Regras, memória, logs — tudo aqui.
"""

import sqlite3
import json
import os
from datetime import datetime
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "bd" / "controler.db"


def get_conn():
    """Retorna conexão SQLite com row_factory."""
    os.makedirs(DB_PATH.parent, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=DELETE")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Cria todas as tabelas se não existirem."""
    conn = get_conn()
    conn.executescript("""

    -- Projetos cadastrados no controler
    CREATE TABLE IF NOT EXISTS projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        icon        TEXT DEFAULT '📁',
        description TEXT,
        created_at  TEXT DEFAULT (datetime('now')),
        active      INTEGER DEFAULT 1
    );

    -- Ações/botões de cada projeto
    CREATE TABLE IF NOT EXISTS actions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        name        TEXT NOT NULL,
        description TEXT,
        action_type TEXT NOT NULL,
        config      TEXT,
        sort_order  INTEGER DEFAULT 0,
        active      INTEGER DEFAULT 1
    );

    -- Regras persistentes por projeto
    CREATE TABLE IF NOT EXISTS rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        category    TEXT NOT NULL,
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        severity    TEXT DEFAULT 'mandatory',
        created_at  TEXT DEFAULT (datetime('now')),
        active      INTEGER DEFAULT 1
    );


    -- Memória geral por projeto (substituível, versionada)
    CREATE TABLE IF NOT EXISTS memory (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        content     TEXT NOT NULL,
        version     INTEGER DEFAULT 1,
        updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- Logs de execução (deploys, scripts, etc.)
    CREATE TABLE IF NOT EXISTS execution_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        action_type TEXT NOT NULL,
        status      TEXT NOT NULL,
        logs        TEXT,
        started_at  TEXT DEFAULT (datetime('now')),
        finished_at TEXT,
        elapsed_sec REAL
    );

    -- Conversas com o agente IA
    CREATE TABLE IF NOT EXISTS agent_conversations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT,
        title       TEXT,
        messages    TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- Configurações gerais do controler
    CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    -- Memórias tipadas por projeto (DECISION, PATTERN, ERROR, CONTEXT, PERSON)
    CREATE TABLE IF NOT EXISTS memories (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL,
        type        TEXT NOT NULL DEFAULT 'CONTEXT',
        content     TEXT NOT NULL,
        created_at  TEXT DEFAULT (datetime('now'))
    );

    -- Regras em texto livre por projeto (NULL = regras gerais)
    CREATE TABLE IF NOT EXISTS rules_text (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT,
        content     TEXT NOT NULL DEFAULT '',
        updated_at  TEXT DEFAULT (datetime('now'))
    );

    -- Uso do agente IA (custo por conversa)
    CREATE TABLE IF NOT EXISTS agent_usage (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT,
        cost_usd    REAL NOT NULL DEFAULT 0,
        num_turns   INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        created_at  TEXT DEFAULT (datetime('now'))
    );


    -- Findings reportados pelos agentes OpenClaw (monitoramento autônomo)
    -- Cada agente POST aqui quando detecta erros, melhorias, anomalias, etc.
    CREATE TABLE IF NOT EXISTS agent_findings (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id    TEXT NOT NULL,          -- 'openclaw-myclinicsoft', 'openclaw-xospam', etc.
        project_id  TEXT NOT NULL,          -- 'myclinicsoft', 'xospam', 'libertakidz', 'controler'
        type        TEXT NOT NULL,          -- 'ERROR', 'SUGGESTION', 'PERFORMANCE', 'COMPETITOR_INSIGHT', 'DAILY_REPORT', 'SECURITY'
        severity    TEXT DEFAULT 'info',    -- 'critical', 'high', 'warning', 'info'
        title       TEXT NOT NULL,
        content     TEXT,                   -- Detalhes completos (markdown suportado)
        metadata    TEXT,                   -- JSON adicional (ex: log excerpt, stack trace)
        status      TEXT DEFAULT 'open',    -- 'open', 'ack', 'resolved', 'ignored'
        created_at  TEXT DEFAULT (datetime('now')),
        updated_at  TEXT DEFAULT (datetime('now'))
    );

    """)
    conn.commit()
    conn.close()


# ── Helpers CRUD ──

def dict_from_row(row):
    if row is None:
        return None
    return dict(row)


def list_from_rows(rows):
    return [dict(r) for r in rows]


# ── Projects ──

def get_projects():
    conn = get_conn()
    rows = conn.execute("SELECT * FROM projects WHERE active=1 ORDER BY created_at").fetchall()
    conn.close()
    return list_from_rows(rows)


def get_project(project_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    conn.close()
    return dict_from_row(row)


def upsert_project(project_id, name, icon='📁', description=''):
    conn = get_conn()
    conn.execute("""
        INSERT INTO projects (id, name, icon, description) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=?, icon=?, description=?
    """, (project_id, name, icon, description, name, icon, description))
    conn.commit()
    conn.close()


# ── Actions ──

def get_actions(project_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM actions WHERE project_id=? AND active=1 ORDER BY sort_order",
        (project_id,)
    ).fetchall()
    conn.close()
    return list_from_rows(rows)


def add_action(project_id, name, description, action_type, config=None):
    conn = get_conn()
    conn.execute(
        "INSERT INTO actions (project_id, name, description, action_type, config) VALUES (?,?,?,?,?)",
        (project_id, name, description, action_type, json.dumps(config) if config else None)
    )
    conn.commit()
    conn.close()


# ── Rules ──

def get_rules(project_id, category=None):
    conn = get_conn()
    if category:
        rows = conn.execute(
            "SELECT * FROM rules WHERE project_id=? AND category=? AND active=1",
            (project_id, category)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM rules WHERE project_id=? AND active=1 ORDER BY severity, category",
            (project_id,)
        ).fetchall()
    conn.close()
    return list_from_rows(rows)


def add_rule(project_id, category, title, content, severity='mandatory'):
    conn = get_conn()
    conn.execute(
        "INSERT INTO rules (project_id, category, title, content, severity) VALUES (?,?,?,?,?)",
        (project_id, category, title, content, severity)
    )
    conn.commit()
    conn.close()


# ── Memory ──

def get_memory(project_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT * FROM memory WHERE project_id=? ORDER BY version DESC LIMIT 1",
        (project_id,)
    ).fetchone()
    conn.close()
    return dict_from_row(row)


def save_memory(project_id, content):
    conn = get_conn()
    current = conn.execute(
        "SELECT MAX(version) as v FROM memory WHERE project_id=?", (project_id,)
    ).fetchone()
    new_version = (current['v'] or 0) + 1
    conn.execute(
        "INSERT INTO memory (project_id, content, version) VALUES (?,?,?)",
        (project_id, content, new_version)
    )
    conn.commit()
    conn.close()
    return new_version


# ── Execution Logs ──

def log_execution(project_id, action_type, status, logs=None, elapsed=None):
    conn = get_conn()
    conn.execute(
        "INSERT INTO execution_logs (project_id, action_type, status, logs, finished_at, elapsed_sec) VALUES (?,?,?,?,?,?)",
        (project_id, action_type, status, json.dumps(logs) if logs else None,
         datetime.now().isoformat() if status != 'running' else None, elapsed)
    )
    conn.commit()
    conn.close()


def get_recent_logs(project_id, limit=20):
    conn = get_conn()
    rows = conn.execute(
        "SELECT * FROM execution_logs WHERE project_id=? ORDER BY started_at DESC LIMIT ?",
        (project_id, limit)
    ).fetchall()
    conn.close()
    return list_from_rows(rows)



# ── Memories (tipadas) ──

def get_memories(project_id, limit=50, search=None):
    conn = get_conn()
    if search:
        rows = conn.execute(
            "SELECT * FROM memories WHERE project_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT ?",
            (project_id, f'%{search}%', limit)
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM memories WHERE project_id=? ORDER BY created_at DESC LIMIT ?",
            (project_id, limit)
        ).fetchall()
    conn.close()
    return list_from_rows(rows)


def get_memories_count_by_type(project_id):
    conn = get_conn()
    rows = conn.execute(
        "SELECT type, COUNT(*) as count FROM memories WHERE project_id=? GROUP BY type",
        (project_id,)
    ).fetchall()
    conn.close()
    return {r['type']: r['count'] for r in rows}


def get_memories_total(project_id):
    conn = get_conn()
    row = conn.execute(
        "SELECT COUNT(*) as n FROM memories WHERE project_id=?", (project_id,)
    ).fetchone()
    conn.close()
    return row['n'] if row else 0


def add_memory_entry(project_id, type_, content):
    conn = get_conn()
    conn.execute(
        "INSERT INTO memories (project_id, type, content) VALUES (?,?,?)",
        (project_id, type_, content)
    )
    conn.commit()
    conn.close()


def delete_memory_entry(memory_id, project_id):
    conn = get_conn()
    conn.execute("DELETE FROM memories WHERE id=? AND project_id=?", (memory_id, project_id))
    conn.commit()
    conn.close()


# ── Rules Text ──

def get_rules_text(project_id=None):
    conn = get_conn()
    if project_id is None:
        row = conn.execute(
            "SELECT content FROM rules_text WHERE project_id IS NULL ORDER BY id DESC LIMIT 1"
        ).fetchone()
    else:
        row = conn.execute(
            "SELECT content FROM rules_text WHERE project_id=? ORDER BY id DESC LIMIT 1",
            (project_id,)
        ).fetchone()
    conn.close()
    return row['content'] if row else ''


def save_rules_text(project_id, content):
    conn = get_conn()
    if project_id is None:
        existing = conn.execute(
            "SELECT id FROM rules_text WHERE project_id IS NULL"
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE rules_text SET content=?, updated_at=datetime('now') WHERE project_id IS NULL",
                (content,)
            )
        else:
            conn.execute("INSERT INTO rules_text (project_id, content) VALUES (NULL, ?)", (content,))
    else:
        existing = conn.execute(
            "SELECT id FROM rules_text WHERE project_id=?", (project_id,)
        ).fetchone()
        if existing:
            conn.execute(
                "UPDATE rules_text SET content=?, updated_at=datetime('now') WHERE project_id=?",
                (content, project_id)
            )
        else:
            conn.execute(
                "INSERT INTO rules_text (project_id, content) VALUES (?,?)", (project_id, content)
            )
    conn.commit()
    conn.close()


# ── Agent Usage (custo diário) ──

def log_agent_usage(project_id: str, cost_usd: float, num_turns: int = 0, duration_ms: int = 0):
    conn = get_conn()
    conn.execute(
        "INSERT INTO agent_usage (project_id, cost_usd, num_turns, duration_ms) VALUES (?,?,?,?)",
        (project_id or "geral", round(cost_usd, 6), num_turns, duration_ms)
    )
    conn.commit()
    conn.close()


def get_daily_cost(days: int = 7):
    conn = get_conn()
    rows = conn.execute("""
        SELECT
            date(created_at) AS day,
            round(sum(cost_usd), 6) AS total_cost,
            count(*) AS num_calls,
            sum(num_turns) AS total_turns
        FROM agent_usage
        WHERE created_at >= date('now', ?)
        GROUP BY date(created_at)
        ORDER BY day DESC
    """, (f"-{days} days",)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_today_cost():
    conn = get_conn()
    row = conn.execute("""
        SELECT
            round(sum(cost_usd), 4) AS total_cost,
            count(*) AS num_calls,
            sum(num_turns) AS total_turns
        FROM agent_usage
        WHERE date(created_at) = date('now')
    """).fetchone()
    conn.close()
    if row:
        return {
            "total_cost": row["total_cost"] or 0.0,
            "num_calls": row["num_calls"] or 0,
            "total_turns": row["total_turns"] or 0,
        }
    return {"total_cost": 0.0, "num_calls": 0, "total_turns": 0}


# ── Agent Findings ──

def add_agent_finding(agent_id: str, project_id: str, type_: str, severity: str,
                      title: str, content: str = None, metadata: dict = None) -> int:
    conn = get_conn()
    cur = conn.execute(
        """INSERT INTO agent_findings
           (agent_id, project_id, type, severity, title, content, metadata)
           VALUES (?,?,?,?,?,?,?)""",
        (agent_id, project_id, type_, severity, title, content,
         json.dumps(metadata, ensure_ascii=False) if metadata else None)
    )
    finding_id = cur.lastrowid
    conn.commit()
    conn.close()
    return finding_id


def get_agent_findings(project_id=None, severity=None, type_=None,
                       status=None, agent_id=None, limit=100, offset=0):
    conn = get_conn()
    clauses, params = [], []
    if project_id:
        clauses.append("project_id=?"); params.append(project_id)
    if severity:
        clauses.append("severity=?"); params.append(severity)
    if type_:
        clauses.append("type=?"); params.append(type_)
    if status:
        clauses.append("status=?"); params.append(status)
    if agent_id:
        clauses.append("agent_id=?"); params.append(agent_id)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    rows = conn.execute(
        f"SELECT * FROM agent_findings {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
        params + [limit, offset]
    ).fetchall()
    conn.close()
    return list_from_rows(rows)


def get_agent_findings_summary():
    """Retorna KPIs dos findings: contagem por projeto, severidade e status."""
    conn = get_conn()

    by_severity = {r['severity']: r['cnt'] for r in conn.execute(
        "SELECT severity, COUNT(*) as cnt FROM agent_findings WHERE status NOT IN ('resolved','ignored') GROUP BY severity"
    ).fetchall()}

    by_project = {r['project_id']: r['cnt'] for r in conn.execute(
        "SELECT project_id, COUNT(*) as cnt FROM agent_findings WHERE status NOT IN ('resolved','ignored') GROUP BY project_id"
    ).fetchall()}

    by_status = {r['status']: r['cnt'] for r in conn.execute(
        "SELECT status, COUNT(*) as cnt FROM agent_findings GROUP BY status"
    ).fetchall()}

    last_24h = conn.execute(
        "SELECT COUNT(*) as cnt FROM agent_findings WHERE created_at >= datetime('now','-1 day')"
    ).fetchone()['cnt']

    last_activity = conn.execute(
        "SELECT created_at FROM agent_findings ORDER BY created_at DESC LIMIT 1"
    ).fetchone()
    last_activity = last_activity['created_at'] if last_activity else None

    conn.close()
    return {
        "by_severity": by_severity,
        "by_project":  by_project,
        "by_status":   by_status,
        "last_24h":    last_24h,
        "last_activity": last_activity,
    }


def update_finding_status(finding_id: int, status: str) -> bool:
    conn = get_conn()
    cur = conn.execute(
        "UPDATE agent_findings SET status=?, updated_at=datetime('now') WHERE id=?",
        (status, finding_id)
    )
    changed = cur.rowcount > 0
    conn.commit()
    conn.close()
    return changed


def delete_agent_finding(finding_id: int) -> bool:
    conn = get_conn()
    cur = conn.execute("DELETE FROM agent_findings WHERE id=?", (finding_id,))
    changed = cur.rowcount > 0
    conn.commit()
    conn.close()
    return changed


def get_agent_findings_count():
    conn = get_conn()
    row = conn.execute(
        "SELECT COUNT(*) as n FROM agent_findings WHERE status NOT IN ('resolved','ignored')"
    ).fetchone()
    conn.close()
    return row['n'] if row else 0
