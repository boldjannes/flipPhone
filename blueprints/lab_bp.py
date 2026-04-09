"""
Lab blueprint – recording, dataset, references, playground.
Mounted at /lab.
"""

import json

from flask import Blueprint, g, jsonify, render_template, request

from database import (
    get_db, now_iso, require_admin, require_api_key, row_to_dict,
)

lab = Blueprint('lab', __name__, url_prefix='/lab')


# ──────────────────────────────────────────────
# Frontend pages
# ──────────────────────────────────────────────
@lab.route('/')
def index():
    return render_template('lab/index.html')


@lab.route('/playground')
def playground():
    return render_template('lab/playground.html')


# ──────────────────────────────────────────────
# CORS preflight for /lab/api/*
# ──────────────────────────────────────────────
@lab.route('/api/<path:_path>', methods=['OPTIONS'])
def options_handler(_path):
    return '', 204


# ──────────────────────────────────────────────
# /lab/api/me
# ──────────────────────────────────────────────
@lab.route('/api/me')
@require_api_key
def me():
    return jsonify({
        'name': g.key_row['name'],
        'is_admin': bool(g.key_row['is_admin']),
    })


# ──────────────────────────────────────────────
# /lab/api/recordings
# ──────────────────────────────────────────────
@lab.route('/api/recordings', methods=['POST'])
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
                sample_count, sample_rate_hz, samples, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                str(data['id']),
                g.key_row['id'],
                str(data['trick'])[:64],
                str(data['timestamp']),
                int(data['durationMs']),
                int(data['sampleCount']),
                int(data['sampleRateHz']),
                json.dumps(data['samples']),
                str(data.get('source', 'lab'))[:32],
                now_iso(),
            ),
        )
        db.commit()
    except Exception:
        return jsonify({'error': 'Recording with this ID already exists'}), 409

    return jsonify({'status': 'saved', 'id': data['id']}), 201


@lab.route('/api/recordings', methods=['GET'])
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

    return jsonify([row_to_dict(r) for r in rows])


@lab.route('/api/recordings/<rec_id>', methods=['DELETE'])
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
# /lab/api/stats
# ──────────────────────────────────────────────
@lab.route('/api/stats')
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
# /lab/api/references
# ──────────────────────────────────────────────
@lab.route('/api/references', methods=['GET'])
@require_api_key
def get_references():
    db = get_db()
    rows = db.execute(
        '''SELECT r.*, k.name AS collector, ref.trick AS ref_trick
           FROM reference_recordings ref
           JOIN recordings r ON ref.recording_id = r.id
           JOIN api_keys k ON r.key_id = k.id'''
    ).fetchall()
    result = {}
    for row in rows:
        result[row['ref_trick']] = row_to_dict(row)
    return jsonify(result)


@lab.route('/api/references/<trick>', methods=['PUT'])
@require_api_key
@require_admin
def set_reference(trick):
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
        (trick, recording_id, now_iso()),
    )
    db.commit()
    return jsonify({'status': 'set', 'trick': trick, 'recording_id': recording_id})


@lab.route('/api/references/<trick>', methods=['DELETE'])
@require_api_key
@require_admin
def delete_reference(trick):
    db = get_db()
    result = db.execute('DELETE FROM reference_recordings WHERE trick = ?', (trick,))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'No reference for this trick'}), 404
    return jsonify({'status': 'removed'})
