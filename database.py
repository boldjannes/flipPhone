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

        -- Game of Skate tables
        CREATE TABLE IF NOT EXISTS game_users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT    UNIQUE NOT NULL,
            password_hash TEXT    NOT NULL,
            display_name  TEXT,
            created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            tricks_landed INTEGER NOT NULL DEFAULT 0,
            games_won     INTEGER NOT NULL DEFAULT 0,
            games_lost    INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS friendships (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            requester_id INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            addressee_id INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            status       TEXT    NOT NULL DEFAULT 'pending',
            created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            UNIQUE(requester_id, addressee_id)
        );

        CREATE TABLE IF NOT EXISTS games (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            challenger_id     INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            opponent_id       INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            status            TEXT    NOT NULL DEFAULT 'invited',
            current_turn_id   INTEGER REFERENCES game_users(id),
            current_role      TEXT    NOT NULL DEFAULT 'setter',
            current_line      TEXT,
            challenger_letters TEXT   NOT NULL DEFAULT '',
            opponent_letters   TEXT   NOT NULL DEFAULT '',
            winner_id         INTEGER REFERENCES game_users(id),
            created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS game_turns (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
            player_id        INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            role             TEXT    NOT NULL,
            tricks_attempted TEXT,
            result           TEXT,
            created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS tricks (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );

        CREATE TABLE IF NOT EXISTS game_sessions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id    INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            token      TEXT    UNIQUE NOT NULL,
            expires_at TEXT    NOT NULL,
            created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
    ''')
    # Migration: add source column to existing databases
    try:
        conn.execute("ALTER TABLE recordings ADD COLUMN source TEXT NOT NULL DEFAULT 'lab'")
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migration: add role column to game_users (NULL | 'lab' | 'admin')
    try:
        conn.execute("ALTER TABLE game_users ADD COLUMN role TEXT DEFAULT NULL")
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migration: store setter's samples alongside current_line
    try:
        conn.execute("ALTER TABLE games ADD COLUMN current_line_samples TEXT")
    except sqlite3.OperationalError:
        pass  # column already exists

    # Migration: make recordings.key_id nullable and add user_id (references game_users)
    cols = {row[1] for row in conn.execute("PRAGMA table_info(recordings)").fetchall()}
    if 'user_id' not in cols:
        conn.execute('PRAGMA foreign_keys = OFF')
        conn.executescript('''
            CREATE TABLE recordings_v2 (
                id              TEXT    PRIMARY KEY,
                key_id          INTEGER REFERENCES api_keys(id) ON DELETE CASCADE,
                user_id         INTEGER REFERENCES game_users(id) ON DELETE SET NULL,
                trick           TEXT    NOT NULL,
                timestamp       TEXT    NOT NULL,
                duration_ms     INTEGER NOT NULL,
                sample_count    INTEGER NOT NULL,
                sample_rate_hz  INTEGER NOT NULL,
                samples         TEXT    NOT NULL,
                source          TEXT    NOT NULL DEFAULT 'lab',
                created_at      TEXT    NOT NULL
            );
            INSERT INTO recordings_v2
                (id, key_id, trick, timestamp, duration_ms,
                 sample_count, sample_rate_hz, samples, source, created_at)
                SELECT id, key_id, trick, timestamp, duration_ms,
                       sample_count, sample_rate_hz, samples, source, created_at
                FROM recordings;
            DROP TABLE recordings;
            ALTER TABLE recordings_v2 RENAME TO recordings;
        ''')
        conn.execute('PRAGMA foreign_keys = ON')
        conn.commit()

    # Migration: normalize recordings.trick from display name to id
    name_to_id = {
        row[0]: row[1]
        for row in conn.execute('SELECT name, id FROM tricks').fetchall()
    }
    if name_to_id:
        conn.executemany(
            'UPDATE recordings SET trick = ? WHERE trick = ?',
            [(id_, name) for name, id_ in name_to_id.items() if name != id_],
        )
        conn.executemany(
            'UPDATE reference_recordings SET trick = ? WHERE trick = ?',
            [(id_, name) for name, id_ in name_to_id.items() if name != id_],
        )

    # Migration: survival_scores table
    conn.execute('''
        CREATE TABLE IF NOT EXISTS survival_scores (
            id         TEXT    PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES game_users(id) ON DELETE CASCADE,
            score      INTEGER NOT NULL,
            created_at TEXT    NOT NULL
        )
    ''')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_sv_score ON survival_scores(score DESC)')

    # Migration: settings key-value table
    conn.execute('''
        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    ''')
    _SETTING_DEFAULTS = [
        ('activation_threshold',    '15'),
        ('activation_pre_buf_ms',   '200'),
        ('activation_post_ms',      '1400'),
        ('activation_cooldown_ms',  '1800'),
        ('confidence_threshold',    '0.80'),
    ]
    conn.executemany(
        'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)',
        _SETTING_DEFAULTS,
    )

    # Seed default tricks if table is empty
    if conn.execute('SELECT COUNT(*) FROM tricks').fetchone()[0] == 0:
        default_tricks = [
            ('kickflip',      'Kickflip'),
            ('heelflip',      'Heelflip'),
            ('fs_shuvit',     'FS Shuvit'),
            ('fs_360_shuvit', 'FS 360 Shuvit'),
            ('bs_shuvit',     'BS Shuvit'),
            ('bs_360_shuvit', 'BS 360 Shuvit'),
            ('treflip',       'Treflip'),
            ('late_kickflip', 'Late Kickflip'),
        ]
        conn.executemany(
            'INSERT OR IGNORE INTO tricks (id, name) VALUES (?, ?)',
            default_tricks,
        )

    conn.commit()
    conn.close()


def normalize_trick(raw, db):
    """Resolve a trick string (id or display name) to its canonical id, or None."""
    row = db.execute('SELECT id FROM tricks WHERE id = ? OR name = ?', (raw, raw)).fetchone()
    return row['id'] if row else None


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
        key = request.headers.get('X-API-Key', '')
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


def require_admin_key(f):
    """Legacy: require API-key-based admin. Kept for backward compat."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not g.key_row['is_admin']:
            return jsonify({'error': 'Admin access required'}), 403
        return f(*args, **kwargs)
    return decorated


def _session_user(token):
    return get_db().execute(
        '''SELECT u.id AS uid, u.username, u.display_name, u.role
           FROM game_sessions s
           JOIN game_users u ON s.user_id = u.id
           WHERE s.token = ? AND s.expires_at > ?''',
        (token, now_iso()),
    ).fetchone()


def require_lab(f):
    """Valid game session with role 'lab' or 'admin'."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': 'Login required'}), 401
        row = _session_user(auth[7:])
        if not row:
            return jsonify({'error': 'Session expired or invalid'}), 401
        if row['role'] not in ('lab', 'admin'):
            return jsonify({'error': 'Lab access required'}), 403
        g.game_user = row
        return f(*args, **kwargs)
    return decorated


def require_admin(f):
    """Valid game session with role 'admin'."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': 'Login required'}), 401
        row = _session_user(auth[7:])
        if not row:
            return jsonify({'error': 'Session expired or invalid'}), 401
        if row['role'] != 'admin':
            return jsonify({'error': 'Admin access required'}), 403
        g.game_user = row
        return f(*args, **kwargs)
    return decorated


def require_admin_or_key(f):
    """Accepts Bearer token (admin role) OR an admin API key via X-API-Key header."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if auth.startswith('Bearer '):
            row = _session_user(auth[7:])
            if row and row['role'] == 'admin':
                g.game_user = row
                return f(*args, **kwargs)
        key = request.headers.get('X-API-Key', '')
        if key:
            row = get_db().execute(
                'SELECT * FROM api_keys WHERE key = ? AND is_admin = 1', (key,)
            ).fetchone()
            if row:
                g.key_row = row
                g.game_user = {'uid': None, 'username': row['name'], 'display_name': None, 'role': 'admin'}
                return f(*args, **kwargs)
        return jsonify({'error': 'Admin access required'}), 403
    return decorated
