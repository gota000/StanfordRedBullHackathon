# 🐦 Flappy Workout

Use your **iPhone as a motion controller** to fly a bird through obstacles on your
**laptop screen**. Raise and lower your arm to do reps — the phone's tilt drives the
bird's height in real time. Includes a live rep counter, a shared leaderboard, and a
**Gemini-powered** motivational challenge generator.

Built for the Stanford × Red Bull hackathon. Hackathon-simple, single Node service,
deployable to **Google Cloud Run**.

## How it works

- One Node server serves the laptop game page (`/`) and the phone controller
  (`/controller.html`), and runs a **WebSocket relay** that pairs them by a 4-char room code.
- The laptop shows a **QR code**; scan it with your iPhone to open the controller.
- The phone derives a drift-free **arm-height** from the DeviceMotion gravity vector,
  after a quick 2-step calibration (arm low / arm high), and streams it to the laptop.
- A **rep** = one full up→down arm cycle. Score = obstacles passed (shared leaderboard).
- Gemini (`gemini-2.5-flash`) generates a motivational challenge; falls back to built-in
  challenges if no API key is set.

## Run locally

```bash
npm install
# optional, for live Gemini challenges:
cp .env.example .env && echo "GEMINI_API_KEY=YOUR_KEY" > .env
npm start
```

Open **http://localhost:8080** on your laptop.

- **No phone?** Click **"No phone? Play with mouse →"** to play with the mouse (great for dev).
- **With an iPhone:** iOS requires HTTPS for motion, so localhost won't reach the phone.
  Either deploy to Cloud Run (below) or expose your local server with HTTPS:
  ```bash
  npx ngrok http 8080
  ```
  Then open the printed `https://…` URL on your laptop and scan the QR with your phone.

## Deploy to Google Cloud Run

Requires the `gcloud` CLI and a GCP project with Cloud Run + Artifact Registry enabled.

```bash
gcloud run deploy flappy-workout \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --min-instances 1 --max-instances 1 \
  --set-env-vars GEMINI_API_KEY=YOUR_KEY
```

> **Why `--min/--max-instances 1`?** The leaderboard and the phone↔laptop pairing live in
> memory, so both WebSocket connections must land on the same instance. A single instance
> keeps state coherent — perfect for a demo. Cloud Run's automatic HTTPS is also what makes
> iOS DeviceMotion permission work.

Cloud Run prints a `https://…run.app` URL. Open it on your laptop and scan the QR.

## Endpoints

| Method | Path              | Purpose                                  |
|--------|-------------------|------------------------------------------|
| GET    | `/`               | Laptop game screen                       |
| GET    | `/controller.html`| Phone controller (`?room=CODE`)          |
| GET    | `/healthz`        | Health check                             |
| GET    | `/api/leaderboard`| Top scores (JSON)                        |
| POST   | `/api/score`      | `{ name, score }` → updated leaderboard  |
| POST   | `/api/challenge`  | Gemini challenge `{ title, message, repGoal }` |
| WS     | `/ws`             | Relay (`?role=display` / `?role=controller&room=CODE`) |

## Project layout

```
server.js              # Express + WS relay + REST + Gemini proxy
public/
  index.html           # laptop game screen
  controller.html      # phone controller
  css/styles.css
  js/game.js           # canvas game, WS display client, leaderboard + challenge UI, mouse-fallback
  js/controller.js     # iOS permission, calibration, tilt→height, rep detection, WS sender
Dockerfile
```
