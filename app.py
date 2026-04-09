"""
FlipPhone – Application factory

Usage
-----
# 1. Install dependencies
pip install -r requirements.txt

# 2. Create the first (admin) key
python app.py create-key "admin" --admin

# 3. Create keys for friends
python app.py create-key "alice"

# 4. List keys
python app.py list-keys

# 5. Revoke a key by its numeric ID
python app.py revoke-key 3

# 6. Start the server (default port 5000)
python app.py runserver
python app.py runserver --port 8080

Environment variables
---------------------
FLIPPHONE_DB   Path to the SQLite database file (default: flipphone.db)
PORT           Port to listen on when running without --port (default: 5000)
"""

import argparse
import os
import sqlite3
import urllib.error
import urllib.request

from flask import Flask, jsonify, request

from database import DB_PATH, close_db, generate_key, init_db, now_iso

PREDICTION_API_URL = os.environ.get('PREDICTION_API_URL', 'http://localhost:8000')


def create_app():
    app = Flask(
        __name__,
        static_folder='static',
        template_folder='templates',
    )

    # Register teardown
    app.teardown_appcontext(close_db)

    # ── CORS ──
    @app.after_request
    def add_cors(response):
        response.headers['Access-Control-Allow-Origin'] = '*'
        response.headers['Access-Control-Allow-Headers'] = 'Content-Type, X-API-Key'
        response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        return response

    # ── Predict proxy (stays at /api/predict, no auth) ──
    @app.route('/api/predict', methods=['POST'])
    def proxy_predict():
        data = request.get_data()
        target = PREDICTION_API_URL.rstrip('/') + '/api/predict'
        try:
            req = urllib.request.Request(
                target,
                data=data,
                headers={'Content-Type': 'application/json'},
                method='POST',
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                body = resp.read()
                return app.response_class(response=body, status=resp.status, mimetype='application/json')
        except urllib.error.HTTPError as e:
            body = e.read()
            return app.response_class(response=body, status=e.code, mimetype='application/json')
        except Exception as e:
            return jsonify({'error': f'Prediction service unavailable: {str(e)}'}), 502

    @app.route('/api/<path:_path>', methods=['OPTIONS'])
    def options_handler(_path):
        return '', 204

    # ── Register blueprints ──
    from blueprints.lab_bp import lab
    from blueprints.admin_bp import admin
    from blueprints.game_bp import game

    app.register_blueprint(lab)
    app.register_blueprint(admin)
    app.register_blueprint(game)

    return app


# ──────────────────────────────────────────────
# CLI helpers
# ──────────────────────────────────────────────
def _cli_create_key(name, is_admin=False):
    init_db()
    key = generate_key()
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        'INSERT INTO api_keys (key, name, is_admin, created_at) VALUES (?, ?, ?, ?)',
        (key, name, 1 if is_admin else 0, now_iso()),
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
        init_db()
        debug = getattr(args, 'debug', False)
        host = getattr(args, 'host', '0.0.0.0')
        port = getattr(args, 'port', int(os.environ.get('PORT', 5000)))
        app = create_app()
        print(f"FlipPhone server running on http://{host}:{port}")
        app.run(host=host, port=port, debug=debug)
