// Motion-Controlled Flappy Workout — single Node server.
// Serves the static frontend, runs a WebSocket relay that pairs a phone (controller)
// to a laptop (display), keeps an in-memory shared leaderboard, and proxies workout
// challenge generation to Gemini. Designed for a single Cloud Run instance.

import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;

// ---------------------------------------------------------------------------
// In-memory state (single instance only — resets on redeploy, which is fine).
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> { display: ws, controller: ws|null }
let leaderboard = []; // [{ name, score }] sorted desc, capped
const MAX_LEADERBOARD = 10;

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      // Math.random is fine here — room codes are not security-sensitive.
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------------------
// Express app + REST API
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.get('/api/leaderboard', (_req, res) => res.json(leaderboard));

app.post('/api/score', (req, res) => {
  const name = String(req.body?.name ?? 'Anon').slice(0, 16).trim() || 'Anon';
  const score = Math.max(0, Math.floor(Number(req.body?.score) || 0));
  leaderboard.push({ name, score });
  leaderboard.sort((a, b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, MAX_LEADERBOARD);
  res.json(leaderboard);
});

// Hardcoded fallback so the demo never breaks if Gemini is unavailable.
const FALLBACK_CHALLENGES = [
  { title: 'Sky Sprint', message: 'Pump those arms like you mean it — every rep lifts you higher!', repGoal: 20 },
  { title: 'Altitude Attack', message: 'Reach for the clouds! Keep the rhythm and dodge everything.', repGoal: 25 },
  { title: 'Wing Warrior', message: 'Strong reps, steady wings. Show the leaderboard who flies highest!', repGoal: 30 },
];
let fallbackIdx = 0;

const genAI = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

app.post('/api/challenge', async (_req, res) => {
  if (!genAI) {
    const c = FALLBACK_CHALLENGES[fallbackIdx++ % FALLBACK_CHALLENGES.length];
    return res.json({ ...c, source: 'fallback' });
  }
  try {
    const prompt =
      'You are a high-energy fitness coach for a motion-controlled arm-rep arcade game ' +
      'where players raise and lower their arm to fly a bird through obstacles. ' +
      'Invent ONE short, punchy workout challenge. Respond with strict JSON only, no markdown, ' +
      'shaped exactly: {"title": string (<=24 chars, catchy), "message": string ' +
      '(1-2 hype sentences, <=140 chars), "repGoal": integer between 10 and 50}.';

    const response = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 1.1 },
    });

    const text = (response.text || '').trim();
    const parsed = JSON.parse(text);
    const challenge = {
      title: String(parsed.title || 'Workout Challenge').slice(0, 40),
      message: String(parsed.message || 'Give it everything!').slice(0, 200),
      repGoal: Math.min(50, Math.max(10, Math.floor(Number(parsed.repGoal) || 20))),
      source: 'gemini',
    };
    res.json(challenge);
  } catch (err) {
    console.error('Gemini challenge failed, using fallback:', err?.message || err);
    const c = FALLBACK_CHALLENGES[fallbackIdx++ % FALLBACK_CHALLENGES.length];
    res.json({ ...c, source: 'fallback' });
  }
});

// ---------------------------------------------------------------------------
// HTTP server + WebSocket relay
// ---------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function baseUrl(req) {
  // The Origin header is exactly the URL the laptop loaded the page from — the
  // authoritative source for what the QR should point at (works behind any tunnel).
  const origin = req.headers.origin;
  if (origin && /^https?:\/\//.test(origin)) return origin.replace(/\/+$/, '');
  // Fallbacks: honor a reverse proxy's forwarded proto, else infer from the socket.
  const proto = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket.encrypted ? 'https' : 'http');
  return `${proto}://${req.headers.host}`;
}

function send(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const role = url.searchParams.get('role');

  if (role === 'display') {
    const code = makeRoomCode();
    rooms.set(code, { display: ws, controller: null });
    ws.roomCode = code;
    ws.role = 'display';

    // The display can run on localhost (loopback, low-latency) while the phone needs a
    // public HTTPS origin. ?pub= (or PUBLIC_BASE_URL) lets the QR point at the tunnel
    // even though this page loaded from localhost; otherwise fall back to the Origin.
    const pub = url.searchParams.get('pub');
    const publicBase = (pub && /^https?:\/\//.test(pub) ? pub.replace(/\/+$/, '')
                        : process.env.PUBLIC_BASE_URL?.replace(/\/+$/, ''))
                        || baseUrl(req);
    const controllerUrl = `${publicBase}/controller.html?room=${code}`;
    let qr = '';
    try {
      qr = await QRCode.toDataURL(controllerUrl, { margin: 1, width: 320 });
    } catch (e) {
      console.error('QR generation failed:', e?.message || e);
    }
    send(ws, { type: 'room', code, qr, controllerUrl });
  } else if (role === 'controller') {
    const code = (url.searchParams.get('room') || '').toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      send(ws, { type: 'error', error: 'Room not found. Re-scan the code on the game screen.' });
      ws.close();
      return;
    }
    room.controller = ws;
    ws.roomCode = code;
    ws.role = 'controller';
    send(ws, { type: 'paired', code });
    send(room.display, { type: 'controllerJoined' });
  } else {
    ws.close();
    return;
  }

  // Relay every message to the room peer (controller -> display motion, and vice versa).
  ws.on('message', (data) => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const peer = ws.role === 'controller' ? room.display : room.controller;
    if (peer && peer.readyState === WebSocket.OPEN) peer.send(data.toString());
  });

  ws.on('close', () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    if (ws.role === 'display') {
      send(room.controller, { type: 'displayLeft' });
      rooms.delete(ws.roomCode);
    } else if (ws.role === 'controller') {
      room.controller = null;
      send(room.display, { type: 'controllerLeft' });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Flappy Workout server listening on :${PORT}`);
  console.log(`Gemini: ${genAI ? 'enabled' : 'disabled (using fallback challenges)'}`);
});
