"""
Friends blueprint – mounted at /.
Handles friend requests, friend lists, and user search.
"""

import logging

from flask import Blueprint, g, jsonify, request

from database import get_db, now_iso, require_game_session, user_profile

log = logging.getLogger('flipphone.game')

friends = Blueprint('friends', __name__)


@friends.route('/game/api/users/search')
@require_game_session
def search_users():
    q = request.args.get('q', '').strip()
    if len(q) < 2:
        return jsonify([])

    me = g.game_user['uid']
    db = get_db()
    pattern = f'%{q}%'
    rows = db.execute(
        '''SELECT u.* FROM game_users u
           WHERE (u.username LIKE ? OR u.display_name LIKE ?)
             AND u.id != ?
             AND u.id NOT IN (
                 SELECT CASE WHEN requester_id = ? THEN addressee_id ELSE requester_id END
                 FROM friendships
                 WHERE (requester_id = ? OR addressee_id = ?)
                   AND status IN ('pending', 'accepted')
             )
           LIMIT 20''',
        (pattern, pattern, me, me, me, me),
    ).fetchall()

    return jsonify([user_profile(r) for r in rows])


@friends.route('/game/api/friends')
@require_game_session
def list_friends():
    me = g.game_user['uid']
    db = get_db()
    rows = db.execute(
        '''SELECT f.id AS friendship_id, f.created_at AS since,
                  u.id, u.username, u.display_name, u.tricks_landed, u.games_won
           FROM friendships f
           JOIN game_users u ON u.id = CASE
               WHEN f.requester_id = ? THEN f.addressee_id
               ELSE f.requester_id END
           WHERE (f.requester_id = ? OR f.addressee_id = ?)
             AND f.status = 'accepted' ''',
        (me, me, me),
    ).fetchall()

    return jsonify([{
        'friendship_id': r['friendship_id'],
        'user': user_profile(r),
        'since': r['since'],
    } for r in rows])


@friends.route('/game/api/friends/requests')
@require_game_session
def friend_requests():
    me = g.game_user['uid']
    db = get_db()
    rows = db.execute(
        '''SELECT f.id AS friendship_id, f.created_at,
                  u.id, u.username, u.display_name, u.tricks_landed, u.games_won
           FROM friendships f
           JOIN game_users u ON u.id = f.requester_id
           WHERE f.addressee_id = ? AND f.status = 'pending' ''',
        (me,),
    ).fetchall()

    return jsonify([{
        'friendship_id': r['friendship_id'],
        'from_user': user_profile(r),
        'created_at': r['created_at'],
    } for r in rows])


@friends.route('/game/api/friends/sent')
@require_game_session
def sent_friend_requests():
    me = g.game_user['uid']
    db = get_db()
    rows = db.execute(
        '''SELECT f.id AS friendship_id, f.created_at,
                  u.id, u.username, u.display_name, u.tricks_landed, u.games_won
           FROM friendships f
           JOIN game_users u ON u.id = f.addressee_id
           WHERE f.requester_id = ? AND f.status = 'pending' ''',
        (me,),
    ).fetchall()

    return jsonify([{
        'friendship_id': r['friendship_id'],
        'to_user': user_profile(r),
        'created_at': r['created_at'],
    } for r in rows])


@friends.route('/game/api/friends/request', methods=['POST'])
@require_game_session
def send_friend_request():
    data = request.get_json(silent=True) or {}
    target_id = data.get('user_id')
    if not target_id:
        return jsonify({'error': 'user_id is required'}), 400

    me = g.game_user['uid']
    if target_id == me:
        return jsonify({'error': 'Cannot befriend yourself'}), 400

    db = get_db()

    if not db.execute('SELECT 1 FROM game_users WHERE id = ?', (target_id,)).fetchone():
        return jsonify({'error': 'User not found'}), 404

    existing = db.execute(
        '''SELECT id, status FROM friendships
           WHERE (requester_id = ? AND addressee_id = ?)
              OR (requester_id = ? AND addressee_id = ?)''',
        (me, target_id, target_id, me),
    ).fetchone()

    if existing:
        if existing['status'] == 'declined':
            db.execute(
                '''UPDATE friendships SET requester_id = ?, addressee_id = ?,
                          status = 'pending', created_at = ?
                   WHERE id = ?''',
                (me, target_id, now_iso(), existing['id']),
            )
            db.commit()
            return jsonify({'status': 'sent', 'friendship_id': existing['id']}), 201
        return jsonify({'error': 'Friend request already exists'}), 409

    cursor = db.execute(
        'INSERT INTO friendships (requester_id, addressee_id, created_at) VALUES (?, ?, ?)',
        (me, target_id, now_iso()),
    )
    db.commit()
    log.info('Friend request: user %d -> user %d', me, target_id)
    return jsonify({'status': 'sent', 'friendship_id': cursor.lastrowid}), 201


@friends.route('/game/api/friends/accept', methods=['POST'])
@require_game_session
def accept_friend():
    data = request.get_json(silent=True) or {}
    fid = data.get('friendship_id')
    if not fid:
        return jsonify({'error': 'friendship_id is required'}), 400

    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM friendships WHERE id = ?', (fid,)).fetchone()
    if not row:
        return jsonify({'error': 'Request not found'}), 404
    if row['addressee_id'] != me:
        return jsonify({'error': 'Not your request to accept'}), 403
    if row['status'] != 'pending':
        return jsonify({'error': f'Request is already {row["status"]}'}), 409

    db.execute("UPDATE friendships SET status = 'accepted' WHERE id = ?", (fid,))
    db.commit()
    log.info('Friend accepted: friendship %d by user %d', fid, me)
    return jsonify({'status': 'accepted'})


@friends.route('/game/api/friends/decline', methods=['POST'])
@require_game_session
def decline_friend():
    data = request.get_json(silent=True) or {}
    fid = data.get('friendship_id')
    if not fid:
        return jsonify({'error': 'friendship_id is required'}), 400

    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM friendships WHERE id = ?', (fid,)).fetchone()
    if not row:
        return jsonify({'error': 'Request not found'}), 404
    if row['addressee_id'] != me:
        return jsonify({'error': 'Not your request to decline'}), 403
    if row['status'] != 'pending':
        return jsonify({'error': f'Request is already {row["status"]}'}), 409

    db.execute("UPDATE friendships SET status = 'declined' WHERE id = ?", (fid,))
    db.commit()
    return jsonify({'status': 'declined'})


@friends.route('/game/api/friends/<int:friendship_id>', methods=['DELETE'])
@require_game_session
def delete_friend(friendship_id):
    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM friendships WHERE id = ?', (friendship_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Friendship not found'}), 404
    if row['requester_id'] != me and row['addressee_id'] != me:
        return jsonify({'error': 'Not your friendship'}), 403

    db.execute('DELETE FROM friendships WHERE id = ?', (friendship_id,))
    db.commit()
    return jsonify({'status': 'deleted'})
