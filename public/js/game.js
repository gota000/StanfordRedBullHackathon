// Flappy Workout — laptop game client.
// Connects to the server as the "display", pairs with a phone over WebSocket,
// renders the canvas game driven by the streamed arm-height, and manages the
// leaderboard + Gemini challenge UI. Includes a mouse-fallback for phone-free dev.

const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const W = canvas.width;   // logical/internal resolution
const H = canvas.height;

// ---- DOM refs ----
const introOverlay = $('introOverlay');
const setupOverlay = $('setupOverlay');
const pairOverlay = $('pairOverlay');
const overOverlay = $('overOverlay');
const qrImg = $('qr');
const roomCodeEl = $('roomCode');
const pairHint = $('pairHint');
const statusEl = $('status');
const heightFill = $('heightFill');
const hudScore = $('hudScore');
const hudReps = $('hudReps');
const repGoalEl = $('repGoal');
const workoutChip = $('workoutChip');
const finalScore = $('finalScore');
const finalReps = $('finalReps');
const finalVolume = $('finalVolume');
const finalVolumeLabel = $('finalVolumeLabel');
const leaderboardEl = $('leaderboard');

// ---- Game state ----
const STATE = { IDLE: 'idle', PLAYING: 'playing', OVER: 'over' };
let state = STATE.IDLE;
let inputMode = null;            // 'phone' | 'mouse'
let targetH = 0.5;               // latest arm height 0..1 (1 = arm up = bird high)
let birdY = H / 2;
let birdVY = 0;
let obstacles = [];
let score = 0;
let reps = 0;
let repPhase = 'low';            // hysteresis state for rep counting
let repGoal = null;
let spawnTimer = 0;
let lastGapCenter = null;        // previous gap's vertical center, for variation

// ---- Workout setup (chosen on the laptop before play) ----
let workout = 'Bicep Curl';
let weight = 20;                 // numeric weight the player is lifting
let unit = 'lb';                 // 'lb' | 'kg'

const BIRD_X = 170;
const BIRD_R = 18;
const REP_HIGH = 0.8, REP_LOW = 0.2;
const GAP = 190;                 // vertical gap between pipes
const PIPE_W = 78;
const SPAWN_EVERY = 1.55;        // seconds between pipes
const GAP_MARGIN = 55;           // keep gaps off the very top/bottom edges

function baseSpeed() { return 200 + Math.min(160, score * 6); } // px/sec, ramps with score

// Pick the next gap's vertical center, forced at least MIN_DELTA from the previous one
// so consecutive gaps differ a lot (a pronounced zig-zag → the arm must sweep further).
// We sample directly from the valid far region(s), so it's always satisfiable and never
// degrades to a tiny jump. Direction varies when both sides are reachable.
function nextGapCenter() {
  const lo = GAP_MARGIN + GAP / 2;
  const hi = H - GAP_MARGIN - GAP / 2;
  if (lastGapCenter == null) {
    lastGapCenter = lo + Math.random() * (hi - lo);
    return lastGapCenter;
  }
  const MIN_DELTA = (hi - lo) * 0.5;          // ≥ half the band between successive gaps
  const upHi = lastGapCenter - MIN_DELTA;     // upper far region: [lo, upHi]
  const dnLo = lastGapCenter + MIN_DELTA;     // lower far region: [dnLo, hi]
  const upOk = upHi >= lo;
  const dnOk = dnLo <= hi;
  let next;
  if (upOk && dnOk) {
    next = Math.random() < 0.5 ? lo + Math.random() * (upHi - lo)
                               : dnLo + Math.random() * (hi - dnLo);
  } else if (upOk) {
    next = lo + Math.random() * (upHi - lo);
  } else if (dnOk) {
    next = dnLo + Math.random() * (hi - dnLo);
  } else {
    next = lastGapCenter < (lo + hi) / 2 ? hi : lo; // degenerate: jump to the far edge
  }
  lastGapCenter = next;
  return next;
}

// ---- Net debug overlay (enable with ?debug=1) ----
const DEBUG = new URLSearchParams(location.search).has('debug');
const netDebugEl = $('netDebug');
let lastMotionAt = 0, motionGapMax = 0, motionCount = 0, netWinStart = performance.now();
if (DEBUG && netDebugEl) netDebugEl.style.display = 'block';

// ---------------------------------------------------------------------------
// WebSocket display client (with simple reconnect)
// ---------------------------------------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // If this page was opened from localhost (low-latency loopback) but the phone needs
  // a public HTTPS origin, ?pub=<tunnel-url> is forwarded so the QR still points there.
  const pub = new URLSearchParams(location.search).get('pub');
  const q = pub ? `&pub=${encodeURIComponent(pub)}` : '';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=display${q}`);

  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    switch (msg.type) {
      case 'room':
        roomCodeEl.textContent = msg.code;
        if (msg.qr) qrImg.src = msg.qr;
        showPairHint(msg.controllerUrl || '');
        setStatus('Waiting for controller…');
        break;
      case 'controllerJoined':
        setStatus('Controller connected — calibrate on your phone…', true);
        break;
      case 'motion':
        targetH = clamp(Number(msg.h) || 0, 0, 1);
        if (DEBUG) {
          const tNow = performance.now();
          if (lastMotionAt) { const gap = tNow - lastMotionAt; if (gap > motionGapMax) motionGapMax = gap; }
          lastMotionAt = tNow; motionCount++;
        }
        if (inputMode !== 'mouse') {
          inputMode = 'phone';
          if (state === STATE.IDLE) startGame();   // first motion = calibrated & ready
        }
        break;
      case 'controllerLeft':
        setStatus('Controller disconnected.');
        break;
    }
  };

  ws.onclose = () => {
    setStatus('Reconnecting…');
    setTimeout(connect, 1500);
  };
  ws.onerror = () => ws.close();
}

function setStatus(text, live = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', live);
}

// Warn loudly if the QR points at localhost — a phone can't reach the laptop's
// "localhost", and iOS motion also requires HTTPS. (See README: use a tunnel/Cloud Run.)
function showPairHint(controllerUrl) {
  let host = '';
  try { host = new URL(controllerUrl).hostname; } catch { /* ignore */ }
  const unreachable = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const insecureIp = controllerUrl.startsWith('http://') && !unreachable;

  if (unreachable) {
    pairHint.classList.add('warn');
    pairHint.textContent =
      `⚠️ This QR points to ${host} — your phone can't reach that, and iOS needs HTTPS. ` +
      `Serve over HTTPS (ngrok / cloudflared / Cloud Run) and open that URL here, then re-scan.`;
  } else if (insecureIp) {
    pairHint.classList.add('warn');
    pairHint.textContent =
      `⚠️ This is plain HTTP (${host}). iOS only sends motion over HTTPS — ` +
      `use a tunnel or Cloud Run, or motion won't work on iPhone.`;
  } else {
    pairHint.classList.remove('warn');
    pairHint.textContent = 'Scan with your iPhone, tap Enable Motion, then calibrate.';
  }
}

// ---------------------------------------------------------------------------
// Mouse fallback (no phone needed for development/demo)
// ---------------------------------------------------------------------------
$('mouseModeBtn').addEventListener('click', () => {
  inputMode = 'mouse';
  startGame();
});
document.addEventListener('mousemove', (e) => {
  if (inputMode !== 'mouse') return;
  const rect = canvas.getBoundingClientRect();
  const yInternal = ((e.clientY - rect.top) / rect.height) * H;
  targetH = clamp(1 - yInternal / H, 0, 1);
});

// ---------------------------------------------------------------------------
// Launch flow: Instructions -> Pick workout & weight -> Pair phone
// ---------------------------------------------------------------------------
$('introNextBtn').addEventListener('click', () => {
  introOverlay.classList.add('hidden');
  setupOverlay.classList.remove('hidden');
});

// Workout selection — only enabled cards are selectable (others are "coming soon").
document.querySelectorAll('.workout-card:not([disabled])').forEach((card) => {
  card.addEventListener('click', () => {
    document.querySelectorAll('.workout-card').forEach((c) => c.classList.remove('selected'));
    card.classList.add('selected');
    workout = card.dataset.workout;
  });
});

// Weight unit toggle (lb / kg).
$('unitToggle').addEventListener('click', (e) => {
  const btn = e.target.closest('.unit');
  if (!btn) return;
  $('unitToggle').querySelectorAll('.unit').forEach((u) => u.classList.remove('selected'));
  btn.classList.add('selected');
  unit = btn.dataset.unit;
});

$('setupStartBtn').addEventListener('click', () => {
  weight = Math.max(0, Math.min(999, Math.round(Number($('weightInput').value) || 0)));
  $('weightInput').value = weight;
  updateWorkoutChip();
  setupOverlay.classList.add('hidden');
  pairOverlay.classList.remove('hidden');
});

function updateWorkoutChip() {
  workoutChip.textContent = `💪 ${workout} · ${weight} ${unit}`;
}

// ---------------------------------------------------------------------------
// Game lifecycle
// ---------------------------------------------------------------------------
function startGame() {
  state = STATE.PLAYING;
  obstacles = [];
  score = 0;
  reps = 0;
  repPhase = 'low';
  spawnTimer = 0;
  lastGapCenter = null;
  birdY = H * (1 - targetH);
  birdVY = 0;
  introOverlay.classList.add('hidden');
  setupOverlay.classList.add('hidden');
  pairOverlay.classList.add('hidden');
  overOverlay.classList.add('hidden');
  setStatus('Live — fly!', true);
}

function gameOver() {
  state = STATE.OVER;
  finalScore.textContent = score;
  finalReps.textContent = reps;
  finalVolume.textContent = reps * weight;          // total weight moved this run
  finalVolumeLabel.textContent = `${unit} lifted`;
  $('nameInput').value = localStorage.getItem('fw_name') || '';
  overOverlay.classList.remove('hidden');
}

$('againBtn').addEventListener('click', startGame);

$('submitScoreBtn').addEventListener('click', async () => {
  const name = ($('nameInput').value || 'Anon').slice(0, 16);
  localStorage.setItem('fw_name', name);
  try {
    const r = await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, score }),
    });
    renderLeaderboard(await r.json());
  } catch { /* ignore for demo */ }
  overOverlay.classList.add('hidden');
  pairOverlay.classList.add('hidden');
  setStatus('Score saved! Move to play again.', true);
  state = STATE.IDLE;
  // In mouse mode there's no incoming motion to auto-restart, so offer the button.
  if (inputMode === 'mouse') pairOverlay.classList.remove('hidden');
});

// ---------------------------------------------------------------------------
// Update + collision
// ---------------------------------------------------------------------------
function update(dt) {
  // Rep counting via hysteresis on arm height (works for phone and mouse alike).
  if (repPhase === 'low' && targetH > REP_HIGH) repPhase = 'high';
  else if (repPhase === 'high' && targetH < REP_LOW) { reps++; repPhase = 'low'; }

  heightFill.style.width = `${Math.round(targetH * 100)}%`;
  hudReps.textContent = reps;
  hudScore.textContent = score;

  if (state !== STATE.PLAYING) return;

  // Bird follows arm height (lerp for smoothness); track velocity for wing flap.
  const desiredY = clamp(H * (1 - targetH), BIRD_R, H - BIRD_R);
  const prevY = birdY;
  birdY += (desiredY - birdY) * Math.min(1, dt * 12);
  birdVY = birdY - prevY;

  // Spawn + move obstacles. Force a big vertical jump from the previous gap so the
  // player has to sweep their arm across a wide range (more travel = more reps).
  spawnTimer += dt;
  if (spawnTimer >= SPAWN_EVERY) {
    spawnTimer = 0;
    obstacles.push({ x: W + PIPE_W, gapY: nextGapCenter(), passed: false });
  }
  const speed = baseSpeed() * dt;
  for (const o of obstacles) {
    o.x -= speed;
    if (!o.passed && o.x + PIPE_W < BIRD_X) { o.passed = true; score++; }
  }
  obstacles = obstacles.filter((o) => o.x + PIPE_W > -10);

  // Collision: bird circle vs the two pipe rects.
  for (const o of obstacles) {
    const withinX = BIRD_X + BIRD_R > o.x && BIRD_X - BIRD_R < o.x + PIPE_W;
    if (!withinX) continue;
    const gapTop = o.gapY - GAP / 2;
    const gapBot = o.gapY + GAP / 2;
    if (birdY - BIRD_R < gapTop || birdY + BIRD_R > gapBot) { gameOver(); return; }
  }
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------
let cloudX = 0;
function draw(dt) {
  ctx.clearRect(0, 0, W, H);

  // Parallax clouds for a bit of life.
  cloudX = (cloudX - 14 * dt) % (W + 200);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  for (let i = 0; i < 4; i++) {
    const cx = ((cloudX + i * 280) % (W + 200)) - 100;
    drawCloud(cx, 90 + (i % 2) * 120);
  }

  // Obstacles.
  for (const o of obstacles) {
    drawPipe(o.x, 0, o.gapY - GAP / 2, true);
    drawPipe(o.x, o.gapY + GAP / 2, H - (o.gapY + GAP / 2), false);
  }

  // Bird.
  if (state !== STATE.IDLE) drawBird(BIRD_X, birdY, birdVY);
}

function drawCloud(x, y) {
  ctx.beginPath();
  ctx.arc(x, y, 26, 0, Math.PI * 2);
  ctx.arc(x + 30, y + 6, 32, 0, Math.PI * 2);
  ctx.arc(x + 64, y, 24, 0, Math.PI * 2);
  ctx.fill();
}

function drawPipe(x, y, h, isTop) {
  const r = 10;
  const grad = ctx.createLinearGradient(x, 0, x + PIPE_W, 0);
  grad.addColorStop(0, '#1e90ff');
  grad.addColorStop(1, '#0a5cc4');
  ctx.fillStyle = grad;
  ctx.shadowColor = 'rgba(30,144,255,0.45)';
  ctx.shadowBlur = 16;
  roundRect(x, y, PIPE_W, h, r);
  ctx.fill();
  // Cap
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#39a0ff';
  const capH = 18;
  const capY = isTop ? y + h - capH : y;
  roundRect(x - 6, capY, PIPE_W + 12, capH, 6);
  ctx.fill();
}

function drawBird(x, y, vy) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(clamp(vy * 0.05, -0.5, 0.5));
  // glow
  ctx.shadowColor = 'rgba(255,219,30,0.6)';
  ctx.shadowBlur = 18;
  // body
  ctx.fillStyle = '#ffdb1e';
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  // wing (flaps with vertical velocity)
  ctx.fillStyle = '#f3b700';
  ctx.beginPath();
  ctx.ellipse(-4, 4 + clamp(vy, -6, 6) * 0.4, 11, 7, -0.4, 0, Math.PI * 2);
  ctx.fill();
  // eye
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(7, -6, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#101010';
  ctx.beginPath(); ctx.arc(9, -6, 3, 0, Math.PI * 2); ctx.fill();
  // beak
  ctx.fillStyle = '#ff7a18';
  ctx.beginPath();
  ctx.moveTo(BIRD_R - 2, -2);
  ctx.lineTo(BIRD_R + 10, 1);
  ctx.lineTo(BIRD_R - 2, 5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  r = Math.min(r, w / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  update(dt);
  draw(dt);
  if (DEBUG && netDebugEl && now - netWinStart >= 1000) {
    const secs = (now - netWinStart) / 1000;
    netDebugEl.textContent =
      `net ${(motionCount / secs).toFixed(0)}/s  gapMax ${motionGapMax.toFixed(0)}ms  H ${targetH.toFixed(2)}`;
    motionCount = 0; motionGapMax = 0; netWinStart = now;
  }
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Leaderboard + Gemini challenge
// ---------------------------------------------------------------------------
function renderLeaderboard(list) {
  leaderboardEl.replaceChildren();
  if (!list || list.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Be the first to score!';
    leaderboardEl.appendChild(li);
    return;
  }
  for (const row of list) {
    const li = document.createElement('li');
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = row.name;
    const sc = document.createElement('span'); sc.className = 'sc'; sc.textContent = row.score;
    li.append(nm, sc);
    leaderboardEl.appendChild(li);
  }
}

async function loadLeaderboard() {
  try {
    const r = await fetch('/api/leaderboard');
    renderLeaderboard(await r.json());
  } catch { renderLeaderboard([]); }
}

$('challengeBtn').addEventListener('click', async () => {
  const btn = $('challengeBtn');
  btn.disabled = true;
  $('challengeText').textContent = 'Summoning a challenge…';
  try {
    const r = await fetch('/api/challenge', { method: 'POST' });
    const c = await r.json();
    // Build via DOM (not innerHTML) so model-generated text can never inject markup.
    const ct = $('challengeText');
    ct.replaceChildren();
    const title = document.createElement('span');
    title.className = 'ct-title';
    title.textContent = c.title;
    ct.append(title, document.createTextNode(c.message));
    repGoal = c.repGoal;
    repGoalEl.textContent = `/${c.repGoal}`;
  } catch {
    $('challengeText').textContent = 'Challenge unavailable — just fly!';
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ New Challenge';
  }
});

// ---------------------------------------------------------------------------
// Helpers + boot
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

updateWorkoutChip();
connect();
loadLeaderboard();
requestAnimationFrame(frame);
