"""
Game blueprint – Game of Skate.
Mounted at /.
"""

import json
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone
from functools import wraps

from flask import Blueprint, g, jsonify, render_template, request
from werkzeug.security import check_password_hash, generate_password_hash

from database import get_db, now_iso

log = logging.getLogger('flipphone.game')

game = Blueprint('game', __name__)

SESSION_LIFETIME_DAYS = 30
USERNAME_RE = re.compile(r'^[a-z0-9_]{3,20}$')


# ──────────────────────────────────────────────
# Game session auth
# ──────────────────────────────────────────────
def _create_session(db, user_id):
    """Create a new session token, return the token string."""
    token = secrets.token_urlsafe(32)
    expires = (datetime.now(timezone.utc) + timedelta(days=SESSION_LIFETIME_DAYS)).isoformat()
    db.execute(
        'INSERT INTO game_sessions (user_id, token, expires_at, created_at) VALUES (?, ?, ?, ?)',
        (user_id, token, expires, now_iso()),
    )
    return token


def _user_response(row):
    """Build the user object returned by auth endpoints."""
    return {
        'id': row['id'],
        'username': row['username'],
        'display_name': row['display_name'],
    }


def require_game_session(f):
    """Validate Bearer token from Authorization header, set g.game_user."""
    @wraps(f)
    def decorated(*args, **kwargs):
        auth = request.headers.get('Authorization', '')
        if not auth.startswith('Bearer '):
            return jsonify({'error': 'Login required'}), 401
        token = auth[7:]
        db = get_db()
        row = db.execute(
            '''SELECT s.*, u.id AS uid, u.username, u.display_name,
                      u.tricks_landed, u.games_won, u.games_lost
               FROM game_sessions s
               JOIN game_users u ON s.user_id = u.id
               WHERE s.token = ? AND s.expires_at > ?''',
            (token, now_iso()),
        ).fetchone()
        if not row:
            return jsonify({'error': 'Session expired or invalid'}), 401
        g.game_user = row
        return f(*args, **kwargs)
    return decorated


# ──────────────────────────────────────────────
# Auth API
# ──────────────────────────────────────────────
@game.route('/game/api/auth/register', methods=['POST'])
def auth_register():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username', '')).strip().lower()
    password = str(data.get('password', ''))
    display_name = str(data.get('display_name', '')).strip() or None

    if not USERNAME_RE.match(username):
        return jsonify({'error': 'Username must be 3-20 characters, only a-z 0-9 _'}), 400
    if len(password) < 8:
        return jsonify({'error': 'Password must be at least 8 characters'}), 400

    db = get_db()
    if db.execute('SELECT 1 FROM game_users WHERE username = ?', (username,)).fetchone():
        return jsonify({'error': 'Username already taken'}), 409

    cursor = db.execute(
        'INSERT INTO game_users (username, password_hash, display_name, created_at) VALUES (?, ?, ?, ?)',
        (username, generate_password_hash(password), display_name, now_iso()),
    )
    user_id = cursor.lastrowid
    token = _create_session(db, user_id)
    db.commit()

    user = db.execute('SELECT * FROM game_users WHERE id = ?', (user_id,)).fetchone()
    log.info('User registered: %s (id=%d)', username, user_id)
    return jsonify({'token': token, 'user': _user_response(user)}), 201


@game.route('/game/api/auth/check-username', methods=['POST'])
def auth_check_username():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username', '')).strip().lower()
    if not USERNAME_RE.match(username):
        return jsonify({'available': False, 'reason': 'Invalid format'})
    taken = get_db().execute('SELECT 1 FROM game_users WHERE username = ?', (username,)).fetchone()
    return jsonify({'available': not taken})


@game.route('/game/api/auth/login', methods=['POST'])
def auth_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get('username', '')).strip().lower()
    password = str(data.get('password', ''))

    if not username or not password:
        return jsonify({'error': 'Username and password are required'}), 400

    db = get_db()
    user = db.execute('SELECT * FROM game_users WHERE username = ?', (username,)).fetchone()
    if not user or not check_password_hash(user['password_hash'], password):
        return jsonify({'error': 'Invalid username or password'}), 401

    token = _create_session(db, user['id'])
    db.commit()

    log.info('User logged in: %s (id=%d)', username, user['id'])
    return jsonify({'token': token, 'user': _user_response(user)})


@game.route('/game/api/auth/logout', methods=['POST'])
@require_game_session
def auth_logout():
    auth = request.headers.get('Authorization', '')
    token = auth[7:]
    db = get_db()
    db.execute('DELETE FROM game_sessions WHERE token = ?', (token,))
    db.commit()
    return jsonify({'status': 'logged_out'})


@game.route('/game/api/auth/me')
@require_game_session
def auth_me():
    row = g.game_user
    return jsonify({
        'id': row['uid'],
        'username': row['username'],
        'display_name': row['display_name'],
        'tricks_landed': row['tricks_landed'],
        'games_won': row['games_won'],
        'games_lost': row['games_lost'],
    })


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────
SKATE = 'SKATE'

TRICKS = [
    {'id': 'kickflip',       'name': 'Kickflip'},
    {'id': 'heelflip',       'name': 'Heelflip'},
    {'id': 'fs_shuvit',      'name': 'FS Shuvit'},
    {'id': 'fs_360_shuvit',  'name': 'FS 360 Shuvit'},
    {'id': 'bs_shuvit',      'name': 'BS Shuvit'},
    {'id': 'bs_360_shuvit',  'name': 'BS 360 Shuvit'},
    {'id': 'treflip',        'name': 'Treflip'},
    {'id': 'late_kickflip',  'name': 'Late Kickflip'},
]

# Fast lookups: accept both id ("kickflip") and display name ("Kickflip")
_TRICK_BY_ID   = {t['id']: t for t in TRICKS}
_TRICK_BY_NAME = {t['name']: t for t in TRICKS}

def _normalize_trick(raw):
    """Resolve a trick string (id or display name) to its canonical id."""
    if raw in _TRICK_BY_ID:
        return raw
    t = _TRICK_BY_NAME.get(raw)
    return t['id'] if t else None


def _user_profile(row):
    """Extract public user profile from a db row."""
    return {
        'id': row['id'],
        'username': row['username'],
        'display_name': row['display_name'],
        'tricks_landed': row['tricks_landed'],
        'games_won': row['games_won'],
    }


def _game_state(row, db):
    """Build full game state dict from a games row."""
    challenger = db.execute('SELECT * FROM game_users WHERE id = ?', (row['challenger_id'],)).fetchone()
    opponent = db.execute('SELECT * FROM game_users WHERE id = ?', (row['opponent_id'],)).fetchone()
    return {
        'id': row['id'],
        'challenger': _user_profile(challenger),
        'opponent': _user_profile(opponent),
        'status': row['status'],
        'current_turn_id': row['current_turn_id'],
        'current_role': row['current_role'],
        'current_line': json.loads(row['current_line']) if row['current_line'] else None,
        'challenger_letters': row['challenger_letters'],
        'opponent_letters': row['opponent_letters'],
        'winner_id': row['winner_id'],
        'created_at': row['created_at'],
        'updated_at': row['updated_at'],
    }


def _next_letter(current_letters):
    """Return the next SKATE letter to append."""
    idx = len(current_letters)
    if idx >= len(SKATE):
        return None
    return SKATE[idx]


def _check_game_over(g_row):
    """Return winner_id if someone has all 5 letters, else None."""
    if len(g_row['challenger_letters']) >= 5:
        return g_row['opponent_id']  # challenger lost → opponent wins
    if len(g_row['opponent_letters']) >= 5:
        return g_row['challenger_id']  # opponent lost → challenger wins
    return None


def _other_player(g_row, me):
    """Return the id of the other player in the game."""
    if g_row['challenger_id'] == me:
        return g_row['opponent_id']
    return g_row['challenger_id']


# ──────────────────────────────────────────────
# Tricks catalogue (single source of truth)
# ──────────────────────────────────────────────
@game.route('/game/api/tricks')
def list_tricks():
    return jsonify(TRICKS)


# ──────────────────────────────────────────────
# Game recordings (auto-save for ML training data)
# ──────────────────────────────────────────────
@game.route('/game/api/recordings', methods=['POST'])
@require_game_session
def save_game_recording():
    data = request.get_json(silent=True) or {}
    trick = str(data.get('trick', ''))[:64]
    samples = data.get('samples')
    source = str(data.get('source', 'game'))[:32]

    if not trick or not isinstance(samples, list) or len(samples) < 5:
        return jsonify({'error': 'trick and samples required'}), 400

    import uuid
    rec_id = str(uuid.uuid4())
    me = g.game_user['uid']
    db = get_db()

    # Compute metadata from samples
    duration_ms = samples[-1].get('t', 0) if samples else 0
    sample_count = len(samples)
    sample_rate = round(sample_count / max(duration_ms / 1000, 0.01)) if duration_ms > 0 else 0

    # Store with key_id = NULL (no API key, game user instead)
    # We need a key_id for the FK — use a sentinel or skip FK.
    # Simplest: insert without FK constraint by using a direct INSERT.
    try:
        db.execute(
            '''INSERT INTO recordings
               (id, key_id, trick, timestamp, duration_ms,
                sample_count, sample_rate_hz, samples, source, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (
                rec_id,
                1,  # default key_id — game recordings attributed to system
                trick,
                now_iso(),
                int(duration_ms),
                sample_count,
                sample_rate,
                json.dumps(samples),
                source,
                now_iso(),
            ),
        )
        db.commit()
    except Exception:
        return jsonify({'error': 'Could not save recording'}), 500

    return jsonify({'status': 'saved', 'id': rec_id}), 201


# ──────────────────────────────────────────────
# Poll endpoint
# ──────────────────────────────────────────────
@game.route('/game/api/poll')
@require_game_session
def poll():
    me = g.game_user['uid']
    db = get_db()

    # ── Pending games (invitations sent TO me) — always return all ──
    pending_rows = db.execute(
        '''SELECT * FROM games
           WHERE opponent_id = ? AND status = 'invited'
           ORDER BY updated_at DESC''',
        (me,),
    ).fetchall()

    # ── Active games (I'm either challenger or opponent) — always return all ──
    active_rows = db.execute(
        '''SELECT * FROM games
           WHERE (challenger_id = ? OR opponent_id = ?)
             AND status = 'active'
           ORDER BY updated_at DESC''',
        (me, me),
    ).fetchall()

    # ── Friend requests count ──
    fr_count = db.execute(
        "SELECT COUNT(*) AS c FROM friendships WHERE addressee_id = ? AND status = 'pending'",
        (me,),
    ).fetchone()['c']

    # ── My-turn count (active games where it's my turn) ──
    my_turn = db.execute(
        '''SELECT COUNT(*) AS c FROM games
           WHERE (challenger_id = ? OR opponent_id = ?)
             AND status = 'active'
             AND current_turn_id = ?''',
        (me, me, me),
    ).fetchone()['c']

    # ── Server timestamp for next since parameter ──
    server_time = now_iso()

    return jsonify({
        'pending_games': [_game_state(r, db) for r in pending_rows],
        'active_games': [_game_state(r, db) for r in active_rows],
        'friend_requests_count': fr_count,
        'my_turn_count': my_turn,
        'server_time': server_time,
    })


# ──────────────────────────────────────────────
# Frontend
# ──────────────────────────────────────────────
@game.route('/')
def index():
    return render_template('game/index.html')


# ──────────────────────────────────────────────
# Friends API
# ──────────────────────────────────────────────
@game.route('/game/api/users/search')
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

    return jsonify([_user_profile(r) for r in rows])


@game.route('/game/api/friends')
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
        'user': _user_profile(r),
        'since': r['since'],
    } for r in rows])


@game.route('/game/api/friends/requests')
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
        'from_user': _user_profile(r),
        'created_at': r['created_at'],
    } for r in rows])


@game.route('/game/api/friends/request', methods=['POST'])
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


@game.route('/game/api/friends/accept', methods=['POST'])
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


@game.route('/game/api/friends/decline', methods=['POST'])
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


@game.route('/game/api/friends/<int:friendship_id>', methods=['DELETE'])
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


# ──────────────────────────────────────────────
# Games API
# ──────────────────────────────────────────────
@game.route('/game/api/games/challenge', methods=['POST'])
@require_game_session
def challenge():
    data = request.get_json(silent=True) or {}
    opponent_id = data.get('opponent_id')
    if not opponent_id:
        return jsonify({'error': 'opponent_id is required'}), 400

    me = g.game_user['uid']
    if opponent_id == me:
        return jsonify({'error': 'Cannot challenge yourself'}), 400

    db = get_db()

    # Must be accepted friends
    friend = db.execute(
        '''SELECT 1 FROM friendships
           WHERE ((requester_id = ? AND addressee_id = ?)
              OR  (requester_id = ? AND addressee_id = ?))
             AND status = 'accepted' ''',
        (me, opponent_id, opponent_id, me),
    ).fetchone()
    if not friend:
        return jsonify({'error': 'You must be friends to challenge'}), 403

    now = now_iso()
    cursor = db.execute(
        '''INSERT INTO games
           (challenger_id, opponent_id, status, current_turn_id, current_role,
            created_at, updated_at)
           VALUES (?, ?, 'invited', ?, 'setter', ?, ?)''',
        (me, opponent_id, me, now, now),
    )
    db.commit()

    row = db.execute('SELECT * FROM games WHERE id = ?', (cursor.lastrowid,)).fetchone()
    log.info('Game %d created: user %d challenged user %d', cursor.lastrowid, me, opponent_id)
    return jsonify(_game_state(row, db)), 201


@game.route('/game/api/games')
@require_game_session
def list_games():
    me = g.game_user['uid']
    db = get_db()
    rows = db.execute(
        '''SELECT * FROM games
           WHERE (challenger_id = ? OR opponent_id = ?)
             AND status IN ('invited', 'active')
           ORDER BY updated_at DESC''',
        (me, me),
    ).fetchall()
    return jsonify([_game_state(r, db) for r in rows])


@game.route('/game/api/games/<int:game_id>')
@require_game_session
def get_game(game_id):
    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Game not found'}), 404
    if row['challenger_id'] != me and row['opponent_id'] != me:
        return jsonify({'error': 'Not your game'}), 403
    return jsonify(_game_state(row, db))


@game.route('/game/api/games/<int:game_id>/accept', methods=['POST'])
@require_game_session
def accept_game(game_id):
    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Game not found'}), 404
    if row['opponent_id'] != me:
        return jsonify({'error': 'Only the challenged player can accept'}), 403
    if row['status'] != 'invited':
        return jsonify({'error': f'Game is already {row["status"]}'}), 409

    db.execute(
        "UPDATE games SET status = 'active', updated_at = ? WHERE id = ?",
        (now_iso(), game_id),
    )
    db.commit()
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    return jsonify(_game_state(row, db))


@game.route('/game/api/games/<int:game_id>/decline', methods=['POST'])
@require_game_session
def decline_game(game_id):
    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Game not found'}), 404
    if row['opponent_id'] != me:
        return jsonify({'error': 'Only the challenged player can decline'}), 403
    if row['status'] != 'invited':
        return jsonify({'error': f'Game is already {row["status"]}'}), 409

    db.execute(
        "UPDATE games SET status = 'declined', updated_at = ? WHERE id = ?",
        (now_iso(), game_id),
    )
    db.commit()
    return jsonify({'status': 'declined'})


@game.route('/game/api/games/<int:game_id>/set-line', methods=['POST'])
@require_game_session
def set_line(game_id):
    data = request.get_json(silent=True) or {}
    tricks = data.get('tricks')
    if not isinstance(tricks, list) or not (1 <= len(tricks) <= 3):
        return jsonify({'error': 'tricks must be a list of 1-3 items'}), 400
    # Normalize trick names: accept both id ("kickflip") and display name ("Kickflip")
    normalized = [_normalize_trick(t) for t in tricks]
    invalid = [raw for raw, norm in zip(tricks, normalized) if norm is None]
    if invalid:
        return jsonify({'error': f'Invalid tricks: {", ".join(invalid)}'}), 400
    tricks = normalized

    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Game not found'}), 404
    if row['challenger_id'] != me and row['opponent_id'] != me:
        return jsonify({'error': 'Not your game'}), 403
    if row['status'] != 'active':
        return jsonify({'error': 'Game is not active'}), 409
    if row['current_turn_id'] != me:
        return jsonify({'error': 'Not your turn'}), 403
    if row['current_role'] != 'setter':
        return jsonify({'error': 'You are the matcher, not the setter'}), 409

    now = now_iso()
    other = _other_player(row, me)

    db.execute(
        '''UPDATE games SET current_line = ?, current_role = 'matcher',
                  current_turn_id = ?, updated_at = ?
           WHERE id = ?''',
        (json.dumps(tricks), other, now, game_id),
    )
    db.execute(
        '''INSERT INTO game_turns (game_id, player_id, role, tricks_attempted, created_at)
           VALUES (?, ?, 'setter', ?, ?)''',
        (game_id, me, json.dumps(tricks), now),
    )
    db.commit()
    log.info('Game %d: user %d set line %s', game_id, me, tricks)

    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    return jsonify(_game_state(row, db))


@game.route('/game/api/games/<int:game_id>/submit-attempt', methods=['POST'])
@require_game_session
def submit_attempt(game_id):
    data = request.get_json(silent=True) or {}
    tricks = data.get('tricks')
    success = data.get('success')
    if not isinstance(tricks, list):
        return jsonify({'error': 'tricks must be a list'}), 400
    if not isinstance(success, bool):
        return jsonify({'error': 'success must be a boolean'}), 400

    # Normalize trick names (accept display names from predict API)
    normalized = [_normalize_trick(t) for t in tricks]
    invalid = [raw for raw, norm in zip(tricks, normalized) if norm is None]
    if invalid:
        return jsonify({'error': f'Invalid tricks: {", ".join(invalid)}'}), 400
    tricks = normalized

    me = g.game_user['uid']
    db = get_db()
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    if not row:
        return jsonify({'error': 'Game not found'}), 404
    if row['challenger_id'] != me and row['opponent_id'] != me:
        return jsonify({'error': 'Not your game'}), 403
    if row['status'] != 'active':
        return jsonify({'error': 'Game is not active'}), 409
    if row['current_turn_id'] != me:
        return jsonify({'error': 'Not your turn'}), 403
    if row['current_role'] != 'matcher':
        return jsonify({'error': 'You are the setter, not the matcher'}), 409

    now = now_iso()
    result = 'success' if success else 'fail'

    # Log the turn
    db.execute(
        '''INSERT INTO game_turns (game_id, player_id, role, tricks_attempted, result, created_at)
           VALUES (?, ?, 'matcher', ?, ?, ?)''',
        (game_id, me, json.dumps(tricks), result, now),
    )

    # On success, increment tricks_landed for the matcher
    if success:
        db.execute(
            'UPDATE game_users SET tricks_landed = tricks_landed + ? WHERE id = ?',
            (len(tricks), me),
        )

    # On fail, add a letter
    challenger_letters = row['challenger_letters']
    opponent_letters = row['opponent_letters']
    if not success:
        if me == row['challenger_id']:
            letter = _next_letter(challenger_letters)
            if letter:
                challenger_letters += letter
        else:
            letter = _next_letter(opponent_letters)
            if letter:
                opponent_letters += letter

    # Swap roles: matcher becomes setter
    new_setter = me
    other = _other_player(row, me)

    # Check game over
    # Build a temporary dict to check
    tmp = {
        'challenger_id': row['challenger_id'],
        'opponent_id': row['opponent_id'],
        'challenger_letters': challenger_letters,
        'opponent_letters': opponent_letters,
    }
    winner = _check_game_over(tmp)

    if winner:
        loser = row['challenger_id'] if winner == row['opponent_id'] else row['opponent_id']
        db.execute(
            '''UPDATE games SET challenger_letters = ?, opponent_letters = ?,
                      status = 'finished', winner_id = ?,
                      current_line = NULL, current_turn_id = NULL,
                      updated_at = ?
               WHERE id = ?''',
            (challenger_letters, opponent_letters, winner, now, game_id),
        )
        db.execute('UPDATE game_users SET games_won = games_won + 1 WHERE id = ?', (winner,))
        db.execute('UPDATE game_users SET games_lost = games_lost + 1 WHERE id = ?', (loser,))
        log.info('Game %d finished: winner=%d loser=%d (%s vs %s)',
                 game_id, winner, loser, challenger_letters, opponent_letters)
    else:
        db.execute(
            '''UPDATE games SET challenger_letters = ?, opponent_letters = ?,
                      current_role = 'setter', current_turn_id = ?,
                      current_line = NULL, updated_at = ?
               WHERE id = ?''',
            (challenger_letters, opponent_letters, new_setter, now, game_id),
        )

    db.commit()
    log.info('Game %d submit-attempt: user=%d success=%s letters=(%s/%s)',
             game_id, me, success, challenger_letters, opponent_letters)
    row = db.execute('SELECT * FROM games WHERE id = ?', (game_id,)).fetchone()
    return jsonify(_game_state(row, db))
