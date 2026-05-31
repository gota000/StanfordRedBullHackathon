// Flappy Workout — phone controller client.
// Flow: connect to the room -> request iOS motion permission -> 2-step calibration
// (arm low / arm high) -> stream a normalized arm-height (0..1) to the laptop.
// Height is derived from how far the (EMA-smoothed) gravity vector has swept from
// the LOW calibration pose, normalized by the LOW->HIGH sweep — drift-free and
// independent of how the phone is strapped. Reps are counted locally via
// hysteresis for the player's own feedback.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const room = (params.get('room') || '').toUpperCase();

const statusEl = $('status');
const stepPermission = $('stepPermission');
const stepCalibrate = $('stepCalibrate');
const stepPlay = $('stepPlay');
const tiltFill = $('tiltFill');
const heightFill = $('heightFill');
const repsEl = $('reps');
const debugEl = $('debug');

// ---- Motion state ----
// Arm height is measured as the ANGLE the smoothed gravity vector has swept from
// the LOW calibration pose, normalized by the full LOW->HIGH sweep. This is
// drift-free AND mounting-agnostic: it doesn't matter which device axis points
// along the forearm, only how far the phone has rotated.
let sgx = 0, sgy = 0, sgz = 0;    // EMA-smoothed gravity vector (device frame)
let gInit = false;                // seed the EMA on the first event
let gLow = null;                  // gravity vector captured at arm LOW
let totalAngle = 0;               // angle (rad) between LOW and HIGH gravity vectors
let calStage = null;              // null | 'low' | 'high'
let sending = false;              // true once calibrated -> stream to server
let reps = 0;
let repPhase = 'low';
const ALPHA = 0.15;               // EMA low-pass factor
const REP_HIGH = 0.8, REP_LOW = 0.2;
const DEFAULT_SPAN = Math.PI / 2; // 90deg fallback before HIGH is captured / guard

// ---------------------------------------------------------------------------
// WebSocket to the room
// ---------------------------------------------------------------------------
let ws = null;
function connect() {
  if (!room) { setStatus('No room code. Re-scan the QR on the game screen.', 'err'); return; }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?role=controller&room=${room}`);
  ws.onopen = () => setStatus(`Connected to room ${room}`, 'live');
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'error') setStatus(msg.error, 'err');
    if (msg.type === 'displayLeft') setStatus('Game screen disconnected.', 'err');
  };
  ws.onclose = () => setStatus('Disconnected — retrying…', 'err') || setTimeout(connect, 1500);
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'ctrl-status' + (cls ? ' ' + cls : '');
}

function sendMotion(h) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'motion', h, reps }));
  }
}

// ---------------------------------------------------------------------------
// Motion handling
// devicemotion can fire ~60Hz. We update the EMA every event (cheap, keeps the
// signal smooth) but only transmit to the laptop at ~30Hz.
// ---------------------------------------------------------------------------
let lastSend = 0;
const SEND_INTERVAL_MS = 16;   // ~60Hz cap; devicemotion itself fires ~60Hz, so this is the floor
// ---- Debug instrumentation (shown in #debug): send rate, raw sensor rate, max gap ----
let sendCount = 0, evtCount = 0, evtGapMax = 0, lastEvtAt = 0;
let dbgWinStart = performance.now();
let rateStr = '';
function onMotionEvent(e) {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;

  // One monotonic, single-origin clock for both throttling and instrumentation.
  // (e.timeStamp's epoch/unit is inconsistent across WebKit builds — mixing it with
  // performance.now() via `||` could corrupt the throttle and make sends bursty.)
  const tEvt = performance.now();

  // EMA-smooth the raw gravity vector. accelerationIncludingGravity also carries
  // the arm's own motion acceleration during a curl; smoothing suppresses those
  // spikes so the orientation estimate stays steady.
  if (!gInit) { sgx = g.x; sgy = g.y; sgz = g.z; gInit = true; }
  else {
    sgx += ALPHA * (g.x - sgx);
    sgy += ALPHA * (g.y - sgy);
    sgz += ALPHA * (g.z - sgz);
  }

  const h = normalized();
  tiltFill.style.width = `${Math.round(h * 100)}%`;
  if (heightFill) heightFill.style.width = `${Math.round(h * 100)}%`;

  // Live x/y/z/h every event; send/sensor rates recomputed once per second.
  evtCount++;
  if (lastEvtAt) { const eg = tEvt - lastEvtAt; if (eg > evtGapMax) evtGapMax = eg; }
  lastEvtAt = tEvt;
  if (tEvt - dbgWinStart >= 1000) {
    const s = (tEvt - dbgWinStart) / 1000;
    rateStr = `send ${(sendCount / s).toFixed(0)}/s  evt ${(evtCount / s).toFixed(0)}/s  gap ${evtGapMax.toFixed(0)}ms`;
    sendCount = 0; evtCount = 0; evtGapMax = 0; dbgWinStart = tEvt;
  }
  if (debugEl) {
    debugEl.textContent =
      `x ${sgx.toFixed(1)} y ${sgy.toFixed(1)} z ${sgz.toFixed(1)} | h ${h.toFixed(2)}  ${rateStr}`;
  }

  if (!sending) return;
  if (tEvt - lastSend < SEND_INTERVAL_MS) return;
  lastSend = tEvt;

  // Rep counting (hysteresis) for the player's local feedback.
  if (repPhase === 'low' && h > REP_HIGH) repPhase = 'high';
  else if (repPhase === 'high' && h < REP_LOW) { reps++; repPhase = 'low'; repsEl.textContent = reps; }
  sendMotion(h);
  sendCount++;
}

// Angle (radians) between two 3-vectors.
function angleBetween(ax, ay, az, bx, by, bz) {
  const dot = ax * bx + ay * by + az * bz;
  const ma = Math.hypot(ax, ay, az), mb = Math.hypot(bx, by, bz);
  if (ma === 0 || mb === 0) return 0;
  return Math.acos(Math.max(-1, Math.min(1, dot / (ma * mb))));
}

// Arm height 0..1 = how far the gravity vector has swept from the LOW pose,
// as a fraction of the full LOW->HIGH sweep.
function normalized() {
  if (!gLow) return 0;
  const swept = angleBetween(sgx, sgy, sgz, gLow.x, gLow.y, gLow.z);
  const span = totalAngle || DEFAULT_SPAN;
  return Math.max(0, Math.min(1, swept / span));
}

function startListening() {
  window.addEventListener('devicemotion', onMotionEvent);
}

// ---------------------------------------------------------------------------
// iOS permission + step flow
// ---------------------------------------------------------------------------
$('enableBtn').addEventListener('click', async () => {
  try {
    const needsPrompt = typeof DeviceMotionEvent !== 'undefined'
      && typeof DeviceMotionEvent.requestPermission === 'function';
    if (needsPrompt) {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') { setStatus('Motion permission denied.', 'err'); return; }
    }
    startListening();
    goToCalibration();
  } catch (err) {
    setStatus('Could not enable motion: ' + (err?.message || err), 'err');
  }
});

function goToCalibration() {
  stepPermission.classList.add('hidden');
  stepPlay.classList.add('hidden');
  stepCalibrate.classList.remove('hidden');
  calStage = 'low';
  gLow = null;
  totalAngle = 0;
  $('calTitle').textContent = 'Calibrate: arm LOW';
  $('calHint').textContent = 'Hold your arm all the way DOWN, then tap capture.';
  $('captureBtn').textContent = 'Capture LOW';
}

$('captureBtn').addEventListener('click', () => {
  if (calStage === 'low') {
    gLow = { x: sgx, y: sgy, z: sgz };
    calStage = 'high';
    $('calTitle').textContent = 'Calibrate: arm HIGH';
    $('calHint').textContent = 'Now raise your arm all the way UP, then tap capture.';
    $('captureBtn').textContent = 'Capture HIGH';
  } else if (calStage === 'high') {
    totalAngle = angleBetween(sgx, sgy, sgz, gLow.x, gLow.y, gLow.z);
    // Guard against a too-small sweep (poses nearly identical) so we never blow
    // up tiny sensor noise across the full 0..1 range.
    if (totalAngle < 0.2) totalAngle = DEFAULT_SPAN;
    finishCalibration();
  }
});

function finishCalibration() {
  calStage = null;
  reps = 0; repPhase = 'low'; repsEl.textContent = '0';
  sending = true;
  stepCalibrate.classList.add('hidden');
  stepPlay.classList.remove('hidden');
  setStatus(`Live in room ${room} — go!`, 'live');
}

$('recalBtn').addEventListener('click', () => {
  sending = false;
  goToCalibration();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
connect();
