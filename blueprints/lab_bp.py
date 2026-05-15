"""
Lab blueprint – recording collection viewer.
Mounted at /lab.
"""

import json

from flask import Blueprint, g, jsonify, redirect, render_template, request

from database import get_db, normalize_trick, now_iso, require_lab

lab = Blueprint('lab', __name__, url_prefix='/lab')


# ──────────────────────────────────────────────
# HTML page
# ──────────────────────────────────────────────
@lab.route('/')
def index():
    return render_template('lab/index.html')


@lab.route('/record')
def record():
    return render_template('lab/record.html')


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
# /lab/api/recordings
# ──────────────────────────────────────────────
@lab.route('/api/recordings', methods=['POST'])
@require_lab
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
    trick_id = normalize_trick(str(data['trick'])[:64], db)
    if not trick_id:
        return jsonify({'error': f'Unknown trick: {data["trick"]}'}), 400
    try:
        db.execute(
            '''INSERT INTO recordings
               (id, user_id, trick, timestamp, duration_ms,
                sample_count, sample_rate_hz, samples, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                str(data['id']),
                g.game_user['uid'],
                trick_id,
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
@require_lab
def list_recordings():
    db = get_db()
    if g.game_user['role'] == 'admin':
        rows = db.execute(
            '''SELECT r.id, r.trick, r.duration_ms, r.sample_count, r.created_at,
                      COALESCE(k.name, u.username) AS collector
               FROM recordings r
               LEFT JOIN api_keys k ON r.key_id = k.id
               LEFT JOIN game_users u ON r.user_id = u.id
               ORDER BY r.created_at DESC'''
        ).fetchall()
    else:
        rows = db.execute(
            '''SELECT r.id, r.trick, r.duration_ms, r.sample_count, r.created_at,
                      COALESCE(k.name, u.username) AS collector
               FROM recordings r
               LEFT JOIN api_keys k ON r.key_id = k.id
               LEFT JOIN game_users u ON r.user_id = u.id
               WHERE r.user_id = ?
               ORDER BY r.created_at DESC''',
            (g.game_user['uid'],),
        ).fetchall()
    return jsonify([dict(r) for r in rows])


@lab.route('/api/recordings/<rec_id>', methods=['DELETE'])
@require_lab
def delete_recording(rec_id):
    db = get_db()
    if g.game_user['role'] == 'admin':
        result = db.execute('DELETE FROM recordings WHERE id = ?', (rec_id,))
    else:
        result = db.execute(
            'DELETE FROM recordings WHERE id = ? AND user_id = ?',
            (rec_id, g.game_user['uid']),
        )
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'Not found or not authorized'}), 404
    return jsonify({'status': 'deleted'})


# ──────────────────────────────────────────────
@lab.route('/api/recordings/counts', methods=['GET'])
@require_lab
def recording_counts():
    db = get_db()
    rows = db.execute('SELECT trick, COUNT(*) as count FROM recordings GROUP BY trick').fetchall()
    return jsonify({r['trick']: r['count'] for r in rows})


# /lab/api/references
# ──────────────────────────────────────────────
@lab.route('/api/references', methods=['GET'])
def get_references():
    db = get_db()
    rows = db.execute(
        '''SELECT rr.trick, rr.recording_id, r.samples, r.duration_ms, r.sample_count
           FROM reference_recordings rr
           JOIN recordings r ON rr.recording_id = r.id'''
    ).fetchall()
    result = {}
    for row in rows:
        try:
            samples = json.loads(row['samples'])
        except Exception:
            continue
        result[row['trick']] = {
            'id': row['recording_id'],
            'samples': samples,
            'duration_ms': row['duration_ms'],
            'sample_count': row['sample_count'],
        }
    return jsonify(result)


@lab.route('/api/references/<trick>', methods=['PUT'])
@require_lab
def set_reference(trick):
    data = request.get_json(silent=True) or {}
    recording_id = data.get('recording_id')
    if not recording_id:
        return jsonify({'error': 'recording_id is required'}), 400
    db = get_db()
    if not db.execute('SELECT id FROM recordings WHERE id = ?', (recording_id,)).fetchone():
        return jsonify({'error': 'Recording not found'}), 404
    db.execute(
        '''INSERT INTO reference_recordings (trick, recording_id, set_at)
           VALUES (?, ?, ?)
           ON CONFLICT(trick) DO UPDATE
             SET recording_id = excluded.recording_id, set_at = excluded.set_at''',
        (trick, recording_id, now_iso()),
    )
    db.commit()
    return jsonify({'trick': trick, 'recording_id': recording_id})


@lab.route('/api/references/<trick>', methods=['DELETE'])
@require_lab
def delete_reference(trick):
    db = get_db()
    result = db.execute('DELETE FROM reference_recordings WHERE trick = ?', (trick,))
    db.commit()
    if result.rowcount == 0:
        return jsonify({'error': 'Reference not found'}), 404
    return jsonify({'status': 'deleted'})
