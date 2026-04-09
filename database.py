"""
FlipPhone – Database layer
"""

import json
import os
import secrets
import sqlite3
import string
from datetime import datetime, timezone
from functools import wraps

from flask import g, jsonify, request

DB_PATH = os.environ.get('FLIPPHONE_DB', 'flipphone.db')


def get_db():
    if 'db' not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        g.db = conn
    return g.db


def close_db(_exc=None):
    db = g.pop('db', None)
    if db is not None:
        db.close()


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA foreign_keys = ON')
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS api_keys (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            key        TEXT    NOT NULL UNIQUE,
            name       TEXT    NOT NULL,
            is_admin   INTEGER NOT NULL DEFAULT 0,
            created_at TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS recordings (
            id              TEXT    PRIMARY KEY,
            key_id          INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
            trick           TEXT    NOT NULL,
            timestamp       TEXT    NOT NULL,
            duration_ms     INTEGER NOT NULL,
            sample_count    INTEGER NOT NULL,
            sample_rate_hz  INTEGER NOT NULL,
            samples         TEXT    NOT NULL,
            source          TEXT    NOT NULL DEFAULT 'lab',
            created_at      TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reference_recordings (
            trick           TEXT    PRIMARY KEY,
            recording_id    TEXT    NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            set_at          TEXT    NOT NULL
        );
    ''')
    # Migration: add source column to existing databases
    try:
        conn.execute("ALTER TABLE recordings ADD COLUMN source TEXT NOT NULL DEFAULT 'lab'")
    except sqlite3.OperationalError:
        pass  # column already exists
    conn.commit()
    conn.close()


def generate_key():
    alphabet = string.ascii_letters + string.digits
    return 'fp_' + ''.join(secrets.choice(alphabet) for _ in range(32))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def row_to_dict(row):
    return {
        'id':           row['id'],
        'trick':        row['trick'],
        'timestamp':    row['timestamp'],
        'durationMs':   row['duration_ms'],
        'sampleCount':  row['sample_count'],
        'sampleRateHz': row['sample_rate_hz'],
        'collector':    row['collector'],
        'samples':      json.loads(row['samples']),
    }


# ──────────────────────────────────────────────
# Auth decorators
# ──────────────────────────────────────────────
def require_api_key(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        key = request.headers.get('X-API-Key') or request.args.get('api_key', '')
        if not key:
            return jsonify({'error': 'API key required'}), 401
        row = get_db().execute(
            'SELECT * FROM api_keys WHERE key = ?', (key,)
        ).fetchone()
        if not row:
            return jsonify({'error': 'Invalid API key'}), 403
        g.key_row = row
        return f(*args, **kwargs)
    return decorated


def require_admin(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not g.key_row['is_admin']:
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated
