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
        action_type TEXT NOT NULL,  -- 'deploy', 'script', 'check', 'custom'
        config      TEXT,           -- JSON com parâmetros específicos
        sort_order  INTEGER DEFAULT 0,
        active      INTEGER DEFAULT 1
    );

    -- Regras persistentes por projeto (não se perdem no reinício)
    CREATE TABLE IF NOT EXISTS rules (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT NOT NULL REFERENCES projects(id),
        category    TEXT NOT NULL,  -- 'deploy', 'security', 'buffer', 'agent', 'general'
        title       TEXT NOT NULL,
        content     TEXT NOT NULL,
        severity    TEXT DEFAULT 'mandatory',  -- 'mandatory', 'warning', 'info'
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
        status      TEXT NOT NULL,  -- 'success', 'failed', 'running', 'cancelled'
        logs        TEXT,           -- JSON com detalhes
        started_at  TEXT DEFAULT (datetime('now')),
        finished_at TEXT,
        elapsed_sec REAL
    );

    -- Conversas com o agente IA
    CREATE TABLE IF NOT EXISTS agent_conversations (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id  TEXT,
        title       TEXT,
        messages    TEXT NOT NULL,  -- JSON array de mensagens
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


# ── Agent Conversations ──

def save_conversation(project_id, title, messages):
    conn = get_conn()
    conn.execute(
        "INSERT INTO agent_conversations (project_id, title, messages) VALUES (?,?,?)",
        (project_id, title, json.dumps(messages, ensure_ascii=False))
    )
    conn.commit()
    conn.close()


def get_conversations(project_id, limit=10):
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, project_id, title, created_at FROM agent_conversations WHERE project_id=? ORDER BY updated_at DESC LIMIT ?",
        (project_id, limit)
    ).fetchall()
    conn.close()
    return list_from_rows(rows)


def get_conversation(conv_id):
    conn = get_conn()
    row = conn.execute("SELECT * FROM agent_conversations WHERE id=?", (conv_id,)).fetchone()
    conn.close()
    if row:
        data = dict_from_row(row)
        data['messages'] = json.loads(data['messages'])
        return data
    return None


# ── Settings ──

def get_setting(key, default=None):
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    conn.close()
    return row['value'] if row else default


def set_setting(key, value):
    conn = get_conn()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?",
        (key, value, value)
    )
    conn.commit()
    conn.close()


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
