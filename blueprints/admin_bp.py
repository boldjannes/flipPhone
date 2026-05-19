"""
Admin blueprint – key management, data export.
Mounted at /admin.
"""

import csv
import io
import json
import os
import urllib.error
import urllib.request
from datetime import datetime, timezone

from flask import Blueprint, Response, jsonify, render_template, request, send_file

from database import (
    generate_key, get_db, now_iso, require_admin, require_admin_or_key, row_to_dict,
)

admin = Blueprint('admin', __name__, url_prefix='/admin')

PREDICTION_API_URL = os.environ.get('PREDICTION_API_URL', 'http://localhost:8000')


def _ml_proxy(method, path, body=None):
    """Forward a request to the ML backend, pass response or 502 on failure."""
    target = PREDICTION_API_URL.rstrip('/') + path
    headers = {'Content-Type': 'application/json'} if body is not None else {}
    req = urllib.request.Request(target, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return Response(resp.read(), status=resp.status, mimetype='application/json')
    except urllib.error.HTTPError as e:
        return Response(e.read(), status=e.code, mimetype='application/json')
    except Exception as e:
        return jsonify({'error': f'ML backend unavailable: {str(e)}'}), 502


# ──────────────────────────────────────────────
# HTML pages (auth handled client-side)
# ──────────────────────────────────────────────
@admin.route('/')
def index():
    return render_template('admin/index.html')


@admin.route('/training')
def training_page():
    return render_template('admin/training.html')


@admin.route('/recordings')
def recordings_page():
    return render_template('admin/recordings.html')


@admin.route('/models')
def models_page():
    return render_template('admin/models.html')


@admin.route('/users')
def users_page():
    return render_template('admin/users.html')


@admin.route('/embed')
def embed_page():
    return render_template('admin/embed.html')


@admin.route('/tricks')
def tricks_page():
    return render_template('admin/tricks.html')


# ──────────────────────────────────────────────
# CORS preflight for /admin/api/*
# ──────────────────────────────────────────────
@admin.route('/api/<path:_path>', methods=['OPTIONS'])
def options_handler(_path):
    return '', 204


# ──────────────────────────────────────────────
# /admin/api/users
# ──────────────────────────────────────────────
@admin.route('/api/users', methods=['GET'])
@require_admin
def list_users():
    rows = get_db().execute(
        '''SELECT id, username, display_name, role, created_at,
                  tricks_landed, games_won, games_lost
           FROM game_users ORDER BY id'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@admin.route('/api/users/<int:user_id>/role', methods=['POST'])
@require_admin
def set_user_role(user_id):
    data = request.get_json(silent=True) or {}
    role = data.get('role')
    if role is not None and role not in ('lab', 'admin'):
        return jsonify({'error': 'role must be null, "lab", or "admin"'}), 400
    db = get_db()
    result = db.execute('UPDATE game_users SET role = ? WHERE id = ?', (role, user_id))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'User not found'}), 404
    return jsonify({'id': user_id, 'role': role})


# ──────────────────────────────────────────────
# /admin/api/embeddings
# ──────────────────────────────────────────────
@admin.route('/api/embeddings')
@require_admin
def get_embeddings():
    db = get_db()
    rows = db.execute(
        '''SELECT r.id, r.trick, r.samples, r.duration_ms, r.sample_count,
                  r.created_at,
                  COALESCE(u.username, k.name) AS collector
           FROM recordings r
           LEFT JOIN game_users u ON r.user_id = u.id
           LEFT JOIN api_keys k ON r.key_id = k.id
           ORDER BY r.created_at DESC'''
    ).fetchall()

    meta = {}
    payload = []
    for row in rows:
        try:
            samples = json.loads(row['samples'])
        except Exception:
            continue
        if not samples:
            continue
        meta[row['id']] = {
            'trick':        row['trick'],
            'collector':    row['collector'],
            'duration_ms':  row['duration_ms'],
            'sample_count': row['sample_count'],
            'created_at':   row['created_at'],
        }
        payload.append({'id': row['id'], 'samples': samples})

    if not payload:
        return jsonify([])

    target = PREDICTION_API_URL.rstrip('/') + '/batch_embed'
    body   = json.dumps({'recordings': payload}).encode()
    req    = urllib.request.Request(
        target, data=body,
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            embed_list = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return jsonify({'error': f'ML backend error: {e.code}'}), 502
    except Exception as e:
        return jsonify({'error': f'ML backend unavailable: {str(e)}'}), 502

    result = []
    for entry in embed_list:
        rec_id = entry.get('id')
        if rec_id not in meta or entry.get('x') is None:
            continue
        result.append({'id': rec_id, 'x': entry['x'], 'y': entry['y'],
                        'z': entry.get('z'), **meta[rec_id]})
    return jsonify(result)


# ──────────────────────────────────────────────
# /admin/api/train  (proxy → ML backend)
# ──────────────────────────────────────────────
@admin.route('/api/train', methods=['POST'])
@require_admin
def start_training():
    return _ml_proxy('POST', '/train', body=request.get_data() or b'{}')


@admin.route('/api/train/<job_id>', methods=['GET'])
@require_admin
def training_status(job_id):
    return _ml_proxy('GET', f'/train/{job_id}')


# ──────────────────────────────────────────────
# /admin/api/models  (proxy → ML backend)
# ──────────────────────────────────────────────
@admin.route('/api/models', methods=['GET'])
@require_admin
def list_models():
    return _ml_proxy('GET', '/models')


@admin.route('/api/models/<model_id>/activate', methods=['POST'])
@require_admin
def activate_model(model_id):
    return _ml_proxy('POST', f'/models/{model_id}/activate', body=b'{}')


@admin.route('/api/models/<model_id>/metrics', methods=['GET'])
@require_admin
def model_metrics(model_id):
    return _ml_proxy('GET', f'/models/{model_id}/metrics')


@admin.route('/api/models/<model_id>', methods=['DELETE'])
@require_admin
def delete_model(model_id):
    return _ml_proxy('DELETE', f'/models/{model_id}')


# ──────────────────────────────────────────────
# /admin/api/keys
# ──────────────────────────────────────────────
@admin.route('/api/keys', methods=['GET'])
@require_admin
def list_keys():
    rows = get_db().execute(
        '''SELECT id, name, is_admin, created_at,
                  substr(key, 1, 7) || '...' AS key_preview
           FROM api_keys ORDER BY id'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@admin.route('/api/keys', methods=['POST'])
@require_admin
def create_key():
    data = request.get_json(silent=True) or {}
    name = str(data.get('name', '')).strip()
    if not name:
        return jsonify({'error': 'name is required'}), 400

    key = generate_key()
    db = get_db()
    db.execute(
        'INSERT INTO api_keys (key, name, is_admin, created_at) VALUES (?, ?, 0, ?)',
        (key, name, now_iso()),
    )
    db.commit()
    return jsonify({'key': key, 'name': name}), 201


@admin.route('/api/keys/<int:key_id>', methods=['DELETE'])
@require_admin
def revoke_key(key_id):
    db = get_db()
    result = db.execute('DELETE FROM api_keys WHERE id = ?', (key_id,))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'Key not found'}), 404
    return jsonify({'status': 'revoked'})


# ──────────────────────────────────────────────
# /admin/api/tricks
# ──────────────────────────────────────────────
@admin.route('/api/tricks', methods=['GET'])
@require_admin
def list_tricks():
    db = get_db()
    tricks = db.execute('SELECT id, name, created_at FROM tricks ORDER BY name').fetchall()
    counts = {
        row['trick']: row['cnt']
        for row in db.execute(
            'SELECT trick, COUNT(*) AS cnt FROM recordings GROUP BY trick'
        ).fetchall()
    }
    refs = {
        row['trick']: {'id': row['recording_id'], 'samples': json.loads(row['samples']),
                       'duration_ms': row['duration_ms'], 'sample_count': row['sample_count']}
        for row in db.execute(
            '''SELECT rr.trick, rr.recording_id, r.samples, r.duration_ms, r.sample_count
               FROM reference_recordings rr JOIN recordings r ON rr.recording_id = r.id'''
        ).fetchall()
    }
    result = []
    for t in tricks:
        entry = dict(t)
        entry['recording_count'] = counts.get(t['id'], 0)
        entry['reference'] = refs.get(t['id'])
        result.append(entry)
    return jsonify(result)


@admin.route('/api/tricks', methods=['POST'])
@require_admin
def create_trick():
    data = request.get_json(silent=True) or {}
    trick_id = str(data.get('id', '')).strip().lower().replace(' ', '_')
    name = str(data.get('name', '')).strip()
    if not trick_id or not name:
        return jsonify({'error': 'id and name are required'}), 400
    if not all(c.isalnum() or c == '_' for c in trick_id):
        return jsonify({'error': 'id must be alphanumeric with underscores'}), 400

    db = get_db()
    existing = db.execute('SELECT id FROM tricks WHERE id = ? OR name = ?', (trick_id, name)).fetchone()
    if existing:
        return jsonify({'error': 'Trick already exists'}), 409

    db.execute('INSERT INTO tricks (id, name) VALUES (?, ?)', (trick_id, name))
    db.commit()
    return jsonify({'id': trick_id, 'name': name}), 201


@admin.route('/api/tricks/<trick_id>', methods=['DELETE'])
@require_admin
def delete_trick(trick_id):
    db = get_db()
    result = db.execute('DELETE FROM tricks WHERE id = ?', (trick_id,))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'Trick not found'}), 404
    return jsonify({'status': 'deleted'})


# ──────────────────────────────────────────────
# /admin/api/export
# ──────────────────────────────────────────────
def _get_export_rows(db, min_confidence=None):
    if min_confidence is not None:
        return db.execute(
            '''SELECT r.*, COALESCE(u.username, k.name) AS collector
               FROM recordings r
               LEFT JOIN game_users u ON r.user_id = u.id
               LEFT JOIN api_keys k ON r.key_id = k.id
               WHERE r.confidence IS NULL OR r.confidence >= ?
               ORDER BY r.created_at DESC''',
            (min_confidence,),
        ).fetchall()
    return db.execute(
        '''SELECT r.*, COALESCE(u.username, k.name) AS collector
           FROM recordings r
           LEFT JOIN game_users u ON r.user_id = u.id
           LEFT JOIN api_keys k ON r.key_id = k.id
           ORDER BY r.created_at DESC'''
    ).fetchall()


@admin.route('/api/export/json')
@require_admin_or_key
def export_json():
    min_confidence = request.args.get('min_confidence', type=float)
    rows = _get_export_rows(get_db(), min_confidence)
    if not rows:
        return jsonify({'error': 'No recordings to export'}), 404

    data = [row_to_dict(r) for r in rows]
    buf = io.BytesIO(json.dumps(data, indent=2).encode())
    buf.seek(0)
    ts = datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')
    return send_file(
        buf,
        mimetype='application/json',
        as_attachment=True,
        download_name=f'flipphone_dataset_{ts}.json',
    )


@admin.route('/settings')
def settings_page():
    return render_template('admin/settings.html')


# ──────────────────────────────────────────────
# /admin/api/settings
# ──────────────────────────────────────────────

_SETTING_KEYS = {
    'activation_threshold',
    'activation_pre_buf_ms',
    'activation_post_ms',
    'activation_cooldown_ms',
    'confidence_threshold',
    'training_threshold',
}


@admin.route('/api/settings', methods=['GET'])
@require_admin
def get_settings():
    rows = get_db().execute('SELECT key, value FROM settings').fetchall()
    result = {}
    for row in rows:
        try:
            result[row['key']] = float(row['value'])
        except ValueError:
            result[row['key']] = row['value']
    return jsonify(result)


@admin.route('/api/settings', methods=['PUT'])
@require_admin
def update_settings():
    data = request.get_json(silent=True) or {}
    db = get_db()
    for key, value in data.items():
        if key not in _SETTING_KEYS:
            return jsonify({'error': f'Unknown setting: {key}'}), 400
        db.execute('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
                   (key, str(value)))
    db.commit()
    rows = db.execute('SELECT key, value FROM settings').fetchall()
    result = {}
    for row in rows:
        try:
            result[row['key']] = float(row['value'])
        except ValueError:
            result[row['key']] = row['value']
    return jsonify(result)


# ──────────────────────────────────────────────
# /admin/api/export
# ──────────────────────────────────────────────

@admin.route('/api/export/csv')
@require_admin_or_key
def export_csv():
    min_confidence = request.args.get('min_confidence', type=float)
    rows = _get_export_rows(get_db(), min_confidence)
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
