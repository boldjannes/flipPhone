"""
Admin blueprint – key management, data export.
Mounted at /admin.
"""

import csv
import io
import json
from datetime import datetime, timezone

from flask import Blueprint, g, jsonify, request, send_file

from database import (
    generate_key, get_db, now_iso, require_admin, require_api_key, row_to_dict,
)

admin = Blueprint('admin', __name__, url_prefix='/admin')


# ──────────────────────────────────────────────
# CORS preflight for /admin/api/*
# ──────────────────────────────────────────────
@admin.route('/api/<path:_path>', methods=['OPTIONS'])
def options_handler(_path):
    return '', 204


# ──────────────────────────────────────────────
# /admin/api/keys
# ──────────────────────────────────────────────
@admin.route('/api/keys', methods=['GET'])
@require_api_key
@require_admin
def list_keys():
    rows = get_db().execute(
        '''SELECT id, name, is_admin, created_at,
                  substr(key, 1, 7) || '...' AS key_preview
           FROM api_keys ORDER BY id'''
    ).fetchall()
    return jsonify([dict(r) for r in rows])


@admin.route('/api/keys', methods=['POST'])
@require_api_key
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
# /admin/api/export
# ──────────────────────────────────────────────
def _get_export_rows(db):
    return db.execute(
        '''SELECT r.*, k.name AS collector
           FROM recordings r
           JOIN api_keys k ON r.key_id = k.id
           ORDER BY r.created_at DESC'''
    ).fetchall()


@admin.route('/api/export/json')
@require_api_key
@require_admin
def export_json():
    rows = _get_export_rows(get_db())
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


@admin.route('/api/export/csv')
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
