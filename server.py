"""
FlipPhone – Flask backend

Usage
-----
# 1. Install dependencies
pip install -r requirements.txt

# 2. Create the first (admin) key
python server.py create-key "admin" --admin

# 3. Create keys for friends
python server.py create-key "alice"
python server.py create-key "bob"

# 4. List keys
python server.py list-keys

# 5. Revoke a key by its numeric ID
python server.py revoke-key 3

# 6. Start the server (default port 5000)
python server.py runserver
python server.py runserver --port 8080

Environment variables
---------------------
FLIPPHONE_DB   Path to the SQLite database file (default: flipphone.db)
PORT           Port to listen on when running without --port (default: 5000)
"""

import argparse
import csv
import io
import json
import os
import secrets
import sqlite3
import string
from datetime import datetime, timezone
from functools import wraps

from flask import Flask, g, jsonify, request, send_file, send_from_directory

# ──────────────────────────────────────────────
# App & DB setup
# ──────────────────────────────────────────────
app = Flask(__name__, static_folder='.')
DB_PATH = os.environ.get('FLIPPHONE_DB', 'flipphone.db')


def get_db():
    if 'db' not in g:
        conn = sqlite3.connect(DB_PATH)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys = ON')
        g.db = conn
    return g.db


@app.teardown_appcontext
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
            created_at      TEXT    NOT NULL
        );
        CREATE TABLE IF NOT EXISTS reference_recordings (
            trick           TEXT    PRIMARY KEY,
            recording_id    TEXT    NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
            set_at          TEXT    NOT NULL
        );
    ''')
    conn.commit()
    conn.close()


def _generate_key():
    alphabet = string.ascii_letters + string.digits
    return 'fp_' + ''.join(secrets.choice(alphabet) for _ in range(32))


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


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


# ──────────────────────────────────────────────
# CORS (allow all origins so the frontend can
# live on a different port during development)
# ──────────────────────────────────────────────
@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-API-Key'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    return response


@app.route('/api/<path:_path>', methods=['OPTIONS'])
def options_handler(_path):
    return '', 204


# ──────────────────────────────────────────────
# Static frontend
# ──────────────────────────────────────────────
@app.route('/')
def index():
    return send_from_directory('.', 'index.html')


@app.route('/<path:path>')
def static_files(path):
    # Only serve known static assets; don't let this shadow API routes
    allowed = {'style.css', 'app.js', 'favicon.ico'}
    if path in allowed:
        return send_from_directory('.', path)
    return jsonify({'error': 'Not found'}), 404


# ──────────────────────────────────────────────
# /api/me  – identify the current key
# ──────────────────────────────────────────────
@app.route('/api/me')
@require_api_key
def me():
    return jsonify({
        'name': g.key_row['name'],
        'is_admin': bool(g.key_row['is_admin']),
    })


# ──────────────────────────────────────────────
# /api/recordings
# ──────────────────────────────────────────────
def _row_to_dict(row):
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


@app.route('/api/recordings', methods=['POST'])
@require_api_key
def save_recording():
    data = request.get_json(silent=True)
    if not data:
        return jsonify({'error': 'Invalid or missing JSON body'}), 400

    required = ('id', 'trick', 'timestamp', 'durationMs',
                'sampleCount', 'sampleRateHz', 'samples')
    missing = [f for f in required if f not in data]
    if missing:
        return jsonify({'error': f'Missing fields: {", ".join(missing)}'}), 400

    if not isinstance(data['samples'], list):
        return jsonify({'error': 'samples must be a list'}), 400

    db = get_db()
    try:
        db.execute(
            '''INSERT INTO recordings
               (id, key_id, trick, timestamp, duration_ms,
                sample_count, sample_rate_hz, samples, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                str(data['id']),
                g.key_row['id'],
                str(data['trick'])[:64],
                str(data['timestamp']),
                int(data['durationMs']),
                int(data['sampleCount']),
                int(data['sampleRateHz']),
                json.dumps(data['samples']),
                _now_iso(),
            ),
        )
        db.commit()
    except sqlite3.IntegrityError:
        return jsonify({'error': 'Recording with this ID already exists'}), 409

    return jsonify({'status': 'saved', 'id': data['id']}), 201


@app.route('/api/recordings', methods=['GET'])
@require_api_key
def list_recordings():
    db = get_db()
    if g.key_row['is_admin']:
        rows = db.execute(
            '''SELECT r.*, k.name AS collector
               FROM recordings r
               JOIN api_keys k ON r.key_id = k.id
               ORDER BY r.created_at DESC'''
        ).fetchall()
    else:
        rows = db.execute(
            '''SELECT r.*, k.name AS collector
               FROM recordings r
               JOIN api_keys k ON r.key_id = k.id
               WHERE r.key_id = ?
               ORDER BY r.created_at DESC''',
            (g.key_row['id'],),
        ).fetchall()

    return jsonify([_row_to_dict(r) for r in rows])


@app.route('/api/recordings/<rec_id>', methods=['DELETE'])
@require_api_key
def delete_recording(rec_id):
    db = get_db()
    if g.key_row['is_admin']:
        result = db.execute('DELETE FROM recordings WHERE id = ?', (rec_id,))
    else:
        result = db.execute(
            'DELETE FROM recordings WHERE id = ? AND key_id = ?',
            (rec_id, g.key_row['id']),
        )
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'Not found or not authorized'}), 404
    return jsonify({'status': 'deleted'})


# ──────────────────────────────────────────────
# /api/stats  – per-trick recording counts
# ──────────────────────────────────────────────
@app.route('/api/stats')
@require_api_key
def user_stats():
    db = get_db()
    if g.key_row['is_admin']:
        rows = db.execute(
            '''SELECT trick, COUNT(*) AS count
               FROM recordings
               GROUP BY trick
               ORDER BY count DESC'''
        ).fetchall()
        total = db.execute('SELECT COUNT(*) FROM recordings').fetchone()[0]
    else:
        rows = db.execute(
            '''SELECT trick, COUNT(*) AS count
               FROM recordings
               WHERE key_id = ?
               GROUP BY trick
               ORDER BY count DESC''',
            (g.key_row['id'],),
        ).fetchall()
        total = db.execute(
            'SELECT COUNT(*) FROM recordings WHERE key_id = ?',
            (g.key_row['id'],),
        ).fetchone()[0]

    result = {
        'total': total,
        'by_trick': [{'trick': r['trick'], 'count': r['count']} for r in rows],
    }

    if g.key_row['is_admin']:
        collector_rows = db.execute(
            '''SELECT k.name AS collector, COUNT(*) AS count
               FROM recordings r
               JOIN api_keys k ON r.key_id = k.id
               GROUP BY r.key_id
               ORDER BY count DESC'''
        ).fetchall()
        result['by_collector'] = [
            {'name': r['collector'], 'count': r['count']} for r in collector_rows
        ]

    return jsonify(result)


# ──────────────────────────────────────────────
# /api/references  – reference recordings per trick
# ──────────────────────────────────────────────
@app.route('/api/references', methods=['GET'])
@require_api_key
def get_references():
    """Return all reference recordings with full sample data."""
    db = get_db()
    rows = db.execute(
        '''SELECT r.*, k.name AS collector, ref.trick AS ref_trick
           FROM reference_recordings ref
           JOIN recordings r ON ref.recording_id = r.id
           JOIN api_keys k ON r.key_id = k.id'''
    ).fetchall()
    result = {}
    for row in rows:
        result[row['ref_trick']] = _row_to_dict(row)
    return jsonify(result)


@app.route('/api/references/<trick>', methods=['PUT'])
@require_api_key
@require_admin
def set_reference(trick):
    """Set a recording as the reference for a trick (admin only)."""
    data = request.get_json(silent=True) or {}
    recording_id = data.get('recording_id', '')
    if not recording_id:
        return jsonify({'error': 'recording_id is required'}), 400

    db = get_db()
    rec = db.execute('SELECT id FROM recordings WHERE id = ?', (recording_id,)).fetchone()
    if not rec:
        return jsonify({'error': 'Recording not found'}), 404

    db.execute(
        '''INSERT INTO reference_recordings (trick, recording_id, set_at)
           VALUES (?, ?, ?)
           ON CONFLICT(trick) DO UPDATE SET recording_id = excluded.recording_id, set_at = excluded.set_at''',
        (trick, recording_id, _now_iso()),
    )
    db.commit()
    return jsonify({'status': 'set', 'trick': trick, 'recording_id': recording_id})


@app.route('/api/references/<trick>', methods=['DELETE'])
@require_api_key
@require_admin
def delete_reference(trick):
    """Remove the reference recording for a trick (admin only)."""
    db = get_db()
    result = db.execute('DELETE FROM reference_recordings WHERE trick = ?', (trick,))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'No reference for this trick'}), 404
    return jsonify({'status': 'removed'})


# ──────────────────────────────────────────────
# /api/export
# ──────────────────────────────────────────────
def _get_export_rows(db):
    if g.key_row['is_admin']:
        return db.execute(
            '''SELECT r.*, k.name AS collector
               FROM recordings r
               JOIN api_keys k ON r.key_id = k.id
               ORDER BY r.created_at DESC'''
        ).fetchall()
    return db.execute(
        '''SELECT r.*, k.name AS collector
           FROM recordings r
           JOIN api_keys k ON r.key_id = k.id
           WHERE r.key_id = ?
           ORDER BY r.created_at DESC''',
        (g.key_row['id'],),
    ).fetchall()


@app.route('/api/export/json')
@require_api_key
@require_admin
def export_json():
    rows = _get_export_rows(get_db())
    if not rows:
        return jsonify({'error': 'No recordings to export'}), 404

    data = [_row_to_dict(r) for r in rows]
    buf = io.BytesIO(json.dumps(data, indent=2).encode())
    buf.seek(0)
    ts = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    return send_file(
        buf,
        mimetype='application/json',
        as_attachment=True,
        download_name=f'flipphone_dataset_{ts}.json',
    )


@app.route('/api/export/csv')
@require_api_key
@require_admin
def export_csv():
    rows = _get_export_rows(get_db())
    if not rows:
        return jsonify({'error': 'No recordings to export'}), 404

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        'id', 'trick', 'timestamp', 'durationMs', 'sampleCount',
        'sampleRateHz', 'collector', 't', 'ax', 'ay', 'az', 'gx', 'gy', 'gz',
    ])
    for row in rows:
        for s in json.loads(row['samples']):
            writer.writerow([
                row['id'], row['trick'], row['timestamp'],
                row['duration_ms'], row['sample_count'], row['sample_rate_hz'],
                row['collector'],
                s['t'], s['ax'], s['ay'], s['az'], s['gx'], s['gy'], s['gz'],
            ])

    bytes_buf = io.BytesIO(buf.getvalue().encode())
    bytes_buf.seek(0)
    ts = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    return send_file(
        bytes_buf,
        mimetype='text/csv',
        as_attachment=True,
        download_name=f'flipphone_dataset_{ts}.csv',
    )


# ──────────────────────────────────────────────
# /api/keys  (admin only)
# ──────────────────────────────────────────────
@app.route('/api/keys', methods=['GET'])
@require_api_key
@require_admin
def list_keys():
    rows = get_db().execute(
        '''SELECT id, name, is_admin, created_at,
                  substr(key, 1, 7) || '...' AS key_preview
           FROM api_keys ORDER BY id'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route('/api/keys', methods=['POST'])
@require_api_key
@require_admin
def create_key():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', '')).strip()
    if not name:
        return jsonify({'error': 'name is required'}), 400

    key = _generate_key()
    db = get_db()
    db.execute(
        'INSERT INTO api_keys (key, name, is_admin, created_at) VALUES (?, ?, 0, ?)',
        (key, name, _now_iso()),
    )
    db.commit()
    return jsonify({'key': key, 'name': name}), 201


@app.route('/api/keys/<int:key_id>', methods=['DELETE'])
@require_api_key
@require_admin
def revoke_key(key_id):
    if key_id == g.key_row['id']:
        return jsonify({'error': 'Cannot revoke your own key'}), 400
    db = get_db()
    result = db.execute('DELETE FROM api_keys WHERE id = ?', (key_id,))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'Key not found'}), 404
    return jsonify({'status': 'revoked'})


# ──────────────────────────────────────────────
# CLI helpers
# ──────────────────────────────────────────────
def _cli_create_key(name, is_admin=False):
    init_db()
    key = _generate_key()
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        'INSERT INTO api_keys (key, name, is_admin, created_at) VALUES (?, ?, ?, ?)',
        (key, name, 1 if is_admin else 0, _now_iso()),
    )
    conn.commit()
    conn.close()
    label = 'ADMIN key' if is_admin else 'key'
    print(f"Created {label} for '{name}':")
    print(f"  {key}")


def _cli_list_keys():
    init_db()
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        '''SELECT id, name, is_admin, created_at,
                  substr(key, 1, 7) || '...' AS key_preview
           FROM api_keys ORDER BY id'''
    ).fetchall()
    conn.close()
    if not rows:
        print('No keys found.')
        return
    print(f"{'ID':<4}  {'Name':<20}  {'Admin':<6}  {'Key':<12}  Created")
    print('─' * 62)
    for r in rows:
        admin = 'yes' if r[2] else 'no'
        print(f"{r[0]:<4}  {r[1]:<20}  {admin:<6}  {r[4]:<12}  {r[3][:19]}")


def _cli_revoke_key(key_id):
    init_db()
    conn = sqlite3.connect(DB_PATH)
    result = conn.execute('DELETE FROM api_keys WHERE id = ?', (key_id,))
    conn.commit()
    conn.close()
    if result.rowcount == 0:
        print(f"No key with ID {key_id} found.")
    else:
        print(f"Key {key_id} revoked.")


# ──────────────────────────────────────────────
# Entry point
# ──────────────────────────────────────────────
if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='FlipPhone server')
    sub = parser.add_subparsers(dest='cmd')

    p_ck = sub.add_parser('create-key', help='Create a new API key')
    p_ck.add_argument('name', help='Label for the key (e.g. "alice")')
    p_ck.add_argument('--admin', action='store_true', help='Grant admin privileges')

    sub.add_parser('list-keys', help='List all API keys')

    p_rv = sub.add_parser('revoke-key', help='Revoke a key by its numeric ID')
    p_rv.add_argument('key_id', type=int, help='Numeric ID from list-keys')

    p_rs = sub.add_parser('runserver', help='Start the web server')
    p_rs.add_argument('--host', default='0.0.0.0')
    p_rs.add_argument('--port', type=int, default=int(os.environ.get('PORT', 5000)))
    p_rs.add_argument('--debug', action='store_true')

    args = parser.parse_args()

    if args.cmd == 'create-key':
        _cli_create_key(args.name, args.admin)
    elif args.cmd == 'list-keys':
        _cli_list_keys()
    elif args.cmd == 'revoke-key':
        _cli_revoke_key(args.key_id)
    else:
        # Default / explicit runserver
        init_db()
        debug = getattr(args, 'debug', False)
        host  = getattr(args, 'host', '0.0.0.0')
        port  = getattr(args, 'port', int(os.environ.get('PORT', 5000)))
        print(f"FlipPhone server running on http://{host}:{port}")
        app.run(host=host, port=port, debug=debug)
