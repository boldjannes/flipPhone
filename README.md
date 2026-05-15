# flipPhone

A mobile-first web app for playing Game of Skate with your phone. Flip it like a skateboard, let the ML model judge.

---

## What it is

flipPhone is a multiplayer Game of Skate where tricks are physical phone movements — kickflips, heelflips, shuvits — detected in real time via the device's motion sensors and classified by a machine learning model.

Challenge a friend, set a line of tricks, make them match it. Miss it, you get a letter. First to spell S-K-A-T-E loses.

Every trick performed in-game is silently saved as training data, so the model gets better the more people play.

---

## How it works

```
flip phone → sensor burst → /api/predict → { trick, confidence } → game logic
                                         ↘ saved silently as training sample
```

---

## Tech stack

- **Frontend** — Vanilla HTML/CSS, ES modules bundled with Vite + Three.js, Canvas 2D, Device Motion API
- **Backend** — Python Flask + gunicorn, SQLite
- **ML Service** — separate FastAPI service (see `flipPhone-training`), proxied via `/api/predict`
- **Reverse proxy** — Caddy (automatic HTTPS)

---

## URL structure

| Route | What it is |
|---|---|
| `/` | Game of Skate — login, home, play |
| `/lab` | Recorder, dataset viewer, playground |
| `/admin` | Tricks, recordings, models, embeddings |

`/lab` and `/admin` have no prominent links from the main app. They exist for contributors and admins.

---

## Project structure

```
app.py                      ← Application factory, route registration
database.py                 ← SQLite helpers, schema, auth decorators
blueprints/
  game_bp.py                ← Game of Skate, auth, friends
  lab_bp.py                 ← Recorder, dataset, references
  admin_bp.py               ← Admin tools, export
src/                        ← JS source (ES modules)
  game/                     ← Game frontend (auth, home, friends, recorder…)
  lab/                      ← Lab recorder, playground, embed viewer
  admin/                    ← Tricks manager, embed viewer
  shared/                   ← phone-animation.js, sensor.js
static/
  dist/                     ← Vite build output (gitignored, built in CI)
  *.css / *.svg             ← Static assets
templates/
  game/index.html
  lab/{index,record,playground,embed}.html
  admin/{index,tricks,models,users,embed,recordings}.html
```

---

## Database

Two auth systems run in parallel.

**Game tables** — `game_users`, `game_sessions`, `friendships`, `games`, `game_turns`

**Lab/Admin tables** — `api_keys`, `recordings`, `references`

Recordings have a `source` column (`'game'` or `'lab'`). Game recordings tend to be higher quality — the user had a specific trick to match, so the label is reliable.

---

## Auth

**Game + Lab + Admin (`/`, `/lab`, `/admin`)** — username + password, session token in `localStorage` as `fp_game_token`. Token valid 30 days.

**API keys (`X-API-Key` header)** — used by the training service to fetch the dataset. Managed in `/admin`.

---

## Game of Skate rules

1. Challenger sets a line of 1–3 tricks
2. Opponent must match the line in order
3. Each failed match earns a letter (S → K → A → T → E)
4. Roles flip — the matcher becomes the setter
5. First player to complete S-K-A-T-E loses

Gameplay is async — no need to be online at the same time.

---

## Sensor data format

```json
{ "t": 120, "ax": 0.0, "ay": 9.8, "az": 0.1, "gx": 0.0, "gy": 0.0, "gz": 0.0 }
```

`ax/ay/az` in m/s², `gx/gy/gz` in rad/s. `t` is milliseconds since recording start.

---

## Running locally

```bash
pip install -r requirements.txt

npm install
npm run build          # or: npm run dev (watch mode)

python3 app.py runserver
```

Runs on `http://localhost:5000`. HTTPS is required on real devices for the Device Motion API — use ngrok or deploy to a TLS host.

---

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Default | Description |
|---|---|---|
| `FLIPPHONE_DB` | `flipphone.db` | Path to SQLite database |
| `PREDICTION_API_URL` | `http://localhost:8000` | ML service URL |
| `FLIPPHONE_ALLOWED_ORIGIN` | `*` | CORS allowed origin (set to your domain in prod) |
| `FLIPPHONE_PREDICT_RATE` | `30 per minute` | Rate limit for `/api/predict` |
| `FLIPPHONE_LOG_DIR` | `logs` | Log directory |
| `PORT` | `5000` | Server port |

---

## Deploy

Push to `main` triggers GitHub Actions:

1. Builds JS bundles (`npm ci && npm run build`)
2. SSHes to Hetzner: backup DB → `git fetch` + `git reset --hard` → `pip install`
3. `rsync` uploads `static/dist/` to the server
4. Restarts the `flipphone` systemd service (gunicorn)

---

## iOS note

iOS requires an explicit permission prompt for motion sensors. The app shows a banner if permission hasn't been granted. This must happen on a user gesture — it cannot be triggered automatically.
