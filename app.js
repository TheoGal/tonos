(() => {
'use strict';
const $ = s => document.querySelector(s);

/* ---------- defaults (edit here) ---------- */
const DEF = { freq: 440, wave: 'sine', vol: -18, chan: 'both', a4: 440,
              scopeRange: '- 12',   // scope top edge in dBFS ('0', '-6', … or 'auto' = fit to volume)
              tb: '1' };         // scope time base: ms per division ('0.01' … '50'), or 'c3' = auto, 3 cycles
const STORE = 'tonos-v1';
const FMIN = 1, FMAX_UI = 20000;           // typed range
const SMIN = 20, SMAX = 20000;             // slider range (log)
const NOTES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
const C_AIR = 343;                         // speed of sound, m/s at ~20 °C

const S = Object.assign({}, DEF);
try { Object.assign(S, JSON.parse(localStorage.getItem(STORE) || '{}')); } catch (e) {}
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(S)); } catch (e) {} };

/* ---------- audio graph: osc → gain ┬→ gL/gR → merger → out (unity gain, no pan law)
                                     └→ analyser (scope tap)  ---------- */
let ctx = null, osc = null, trim = null, gain = null, gL = null, gR = null, analyser = null, tbuf = null;
let playing = false, wakeLock = null;

const dbToLin = d => Math.pow(10, d / 20);
const fmax = () => Math.min(FMAX_UI, ctx ? ctx.sampleRate / 2 - 1 : FMAX_UI);

async function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    gain = ctx.createGain(); gain.gain.value = 0;
    trim = ctx.createGain(); trim.connect(gain);       // anti-clip trim (see updateTrim)
    gL = ctx.createGain(); gR = ctx.createGain();
    const merge = ctx.createChannelMerger(2);
    gain.connect(gL).connect(merge, 0, 0);
    gain.connect(gR).connect(merge, 0, 1);
    merge.connect(ctx.destination);
    analyser = ctx.createAnalyser(); analyser.fftSize = 32768; analyser.smoothingTimeConstant = 0;
    tbuf = new Float32Array(analyser.fftSize);
    gain.connect(analyser);
    applyChan();
  }
  if (ctx.state !== 'running') await ctx.resume();
}

async function play() {
  await ensureCtx();
  if (playing) return;
  await updateTrim();
  const t = ctx.currentTime;
  osc = ctx.createOscillator();
  osc.type = S.wave;
  osc.frequency.value = S.freq;
  osc.connect(trim);
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(0, t);
  gain.gain.setTargetAtTime(dbToLin(S.vol), t, 0.012);   // ~50 ms fade-in, no click
  osc.start(t);
  playing = true;
  $('#bPlay').setAttribute('aria-pressed', 'true');
  requestWake();
}

function stop() {
  if (!playing || !ctx) return;
  const t = ctx.currentTime, o = osc;
  gain.gain.cancelScheduledValues(t);
  gain.gain.setValueAtTime(gain.gain.value, t);
  gain.gain.setTargetAtTime(0, t, 0.012);                 // fade-out
  o.stop(t + 0.12);
  o.onended = () => { try { o.disconnect(); } catch (e) {} };
  osc = null; playing = false;
  $('#bPlay').setAttribute('aria-pressed', 'false');
  releaseWake();
  readouts();
}

function applyChan() {
  const t = ctx.currentTime;
  gL.gain.setTargetAtTime(S.chan === 'R' ? 0 : 1, t, 0.01);
  gR.gain.setTargetAtTime(S.chan === 'L' ? 0 : 1, t, 0.01);
}

async function requestWake() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch (e) { wakeLock = null; } }
function releaseWake() { try { wakeLock?.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && playing) requestWake(); });

/* ---------- anti-clip trim ----------
   Browser oscillators are band-limited, so square/saw (and triangle) can overshoot ±1
   by up to ~1–2 dB depending on frequency. We render a short snippet offline, find its
   true peak (4× sinc-upsampled, so peaks between samples count too) and scale the
   oscillator down just enough that the output never exceeds the volume setting. */
const trimCache = new Map();
let trimDb = 0, trimBusy = false, trimAgain = false;
async function wavePeak(wave, f, sr) {
  const key = wave + '|' + Math.round(f) + '|' + sr;
  if (trimCache.has(key)) return trimCache.get(key);
  const N = Math.min(sr * 2, Math.max(4096, Math.ceil(sr / f) + 1024));
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const oc = new OAC(1, N, sr), o = oc.createOscillator();
  o.type = wave; o.frequency.value = f; o.connect(oc.destination); o.start();
  const d = (await oc.startRendering()).getChannelData(0);
  let pk = 0;
  const A = LZ_A, from = 512, to = Math.min(N - A - 1, from + Math.max(2048, Math.ceil(sr / f) + 4));
  for (let t = from; t < to; t += 0.25) {
    const i0 = Math.floor(t); let v = 0;
    for (let j = i0 - A + 1; j <= i0 + A; j++) { const x = t - j; v += d[j] * LZ[Math.round((x < 0 ? -x : x) * LZ_RES)]; }
    if (v < 0) v = -v; if (v > pk) pk = v;
  }
  trimCache.set(key, pk);
  return pk;
}
async function updateTrim() {
  if (!ctx) return;
  if (trimBusy) { trimAgain = true; return; }
  trimBusy = true;
  try {
    do {
      trimAgain = false;
      const pk = await wavePeak(S.wave, S.freq, ctx.sampleRate);
      const lin = pk > 0.999 ? 0.999 / pk : 1;              // only ever turn down, never boost
      trimDb = 20 * Math.log10(lin);
      trim.gain.setTargetAtTime(lin, ctx.currentTime, 0.005);
      showVol();
    } while (trimAgain);
  } catch (e) { /* offline rendering unavailable: run untrimmed */ }
  trimBusy = false;
}

/* ---------- frequency ---------- */
const iFreq = $('#iFreq'), sFreq = $('#sFreq');
const sliderToF = v => SMIN * Math.pow(SMAX / SMIN, v / 10000);
const fToSlider = f => Math.round(10000 * Math.log(Math.min(SMAX, Math.max(SMIN, f)) / SMIN) / Math.log(SMAX / SMIN));
const fmtF = f => f >= 1000 ? f.toFixed(1) : f.toFixed(2);

function setFreq(f, opts = {}) {
  if (!isFinite(f)) return;
  f = Math.min(fmax(), Math.max(FMIN, Math.round(f * 100) / 100));
  S.freq = f;
  if (osc) {
    const prm = osc.frequency, t = ctx.currentTime;
    if (prm.cancelAndHoldAtTime) prm.cancelAndHoldAtTime(t); else prm.cancelScheduledValues(t);
    prm.setTargetAtTime(f, t, opts.glide ? 0.015 : 0.002);
  }
  if (!opts.fromInput) iFreq.value = fmtF(f);
  if (!opts.fromSlider) sFreq.value = fToSlider(f);
  syncNote();
  readouts();
  save();
  updateTrim();
}

function commitInput() {
  const v = parseFloat(String(iFreq.value).replace(',', '.').replace(/[^\d.]/g, ''));
  if (isFinite(v) && v > 0) setFreq(v); else iFreq.value = fmtF(S.freq);
}
iFreq.addEventListener('keydown', e => {
  if (e.key === 'Enter') { commitInput(); iFreq.blur(); }
  else if (e.key === 'Escape') { iFreq.value = fmtF(S.freq); iFreq.blur(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    const d = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
    setFreq(S.freq + d);
  }
});
iFreq.addEventListener('blur', commitInput);
iFreq.addEventListener('focus', () => iFreq.select());

sFreq.addEventListener('input', () => {
  const f = sliderToF(+sFreq.value);
  setFreq(f >= 100 ? Math.round(f) : Math.round(f * 10) / 10, { fromSlider: true, glide: true });
});

// hold-to-repeat for ±1
function repeater(el, fn) {
  let t1 = null, t2 = null;
  const end = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = null; };
  el.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    fn(); end();
    t1 = setTimeout(() => { t2 = setInterval(fn, 45); }, 380);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => el.addEventListener(ev, end));
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } });
}
repeater($('#bDec'), () => setFreq(S.freq - 1));
repeater($('#bInc'), () => setFreq(S.freq + 1));
$('#bHalf').onclick = () => setFreq(S.freq / 2, { glide: true });
$('#bDbl').onclick = () => setFreq(S.freq * 2, { glide: true });

// slider tick labels at their true log positions
(function ticks() {
  const el = $('#ticks');
  [[20,'20'],[50,'50'],[100,'100'],[200,'200'],[500,'500'],[1000,'1k'],[2000,'2k'],[5000,'5k'],[10000,'10k'],[20000,'20k']].forEach(([f, t]) => {
    const s = document.createElement('span');
    const p = Math.log(f / SMIN) / Math.log(SMAX / SMIN);
    s.style.left = `calc(${p * 100}% + ${(0.5 - p) * 16}px)`;   // align with thumb travel
    s.textContent = t; el.appendChild(s);
  });
})();

/* ---------- notes ---------- */
const sNote = $('#sNote'), sOct = $('#sOct'), iA4 = $('#iA4');
NOTES.forEach((n, i) => sNote.add(new Option(n, i)));
for (let o = 0; o <= 9; o++) sOct.add(new Option(String(o), o));

const midiOf = f => 69 + 12 * Math.log2(f / S.a4);
const fOfMidi = m => S.a4 * Math.pow(2, (m - 69) / 12);
function nearest(f) {
  const m = midiOf(f), r = Math.round(m);
  return { midi: r, cents: Math.round((m - r) * 100), name: NOTES[((r % 12) + 12) % 12] + (Math.floor(r / 12) - 1) };
}
function syncNote() {
  const n = nearest(S.freq);
  sNote.value = ((n.midi % 12) + 12) % 12;
  sOct.value = Math.min(9, Math.max(0, Math.floor(n.midi / 12) - 1));
}
function pickNote() { setFreq(fOfMidi((+sOct.value + 1) * 12 + +sNote.value), { glide: true }); }
sNote.onchange = pickNote; sOct.onchange = pickNote;
$('#bSemiDn').onclick = () => setFreq(fOfMidi(Math.round(midiOf(S.freq)) - 1), { glide: true });
$('#bSemiUp').onclick = () => setFreq(fOfMidi(Math.round(midiOf(S.freq)) + 1), { glide: true });

function commitA4() {
  const v = parseFloat(String(iA4.value).replace(',', '.'));
  if (isFinite(v) && v >= 400 && v <= 480) { S.a4 = Math.round(v * 100) / 100; save(); syncNote(); readouts(); }
  iA4.value = S.a4.toFixed(S.a4 % 1 ? 2 : 0);
}
iA4.addEventListener('blur', commitA4);
iA4.addEventListener('keydown', e => { if (e.key === 'Enter') { commitA4(); iA4.blur(); } });

/* ---------- waveform / channel / volume ---------- */
function bindSeg(id, key, onChange) {
  const btns = [...document.querySelectorAll('#' + id + ' button')];
  const sync = () => btns.forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === S[key])));
  btns.forEach(b => b.onclick = () => { S[key] = b.dataset.v; sync(); save(); onChange(); });
  sync();
}
bindSeg('segWave', 'wave', () => { if (osc) osc.type = S.wave; readouts(); updateTrim(); });
bindSeg('segChan', 'chan', () => { if (ctx) applyChan(); });

// scope settings
const sRange = $('#sRange'), sCyc = $('#sCyc');
[['0', '0 dBFS'], ['-6', '−6 dBFS'], ['-12', '−12 dBFS'], ['-18', '−18 dBFS'], ['-24', '−24 dBFS'], ['-40', '−40 dBFS'], ['auto', 'Fit to volume']]
  .forEach(([v, t]) => sRange.add(new Option(t, v)));
// time base: fixed 1-2-5 steps (10 divisions per screen), plus auto modes that fit N cycles
const fmtT = ms => ms >= 1 ? ms + ' ms' : Math.round(ms * 1000) + ' µs';
[0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50]
  .forEach(ms => sCyc.add(new Option(fmtT(ms) + '/div', String(ms))));
[1, 3, 10].forEach(n => sCyc.add(new Option('Auto · ' + n + (n === 1 ? ' cycle' : ' cycles'), 'c' + n)));
if (![...sCyc.options].some(o => o.value === S.tb)) S.tb = DEF.tb;
sRange.value = S.scopeRange; sCyc.value = S.tb;
sRange.onchange = () => { S.scopeRange = sRange.value; save(); };
sCyc.onchange = () => { S.tb = sCyc.value; save(); };

const sVol = $('#sVol');
function showVol() {
  $('#vVol').textContent = (S.vol < 0 ? '−' : '') + Math.abs(S.vol).toFixed(1) + ' dBFS' +
    (trimDb < -0.05 ? '  · anti-clip −' + Math.abs(trimDb).toFixed(1) + ' dB' : '');
}
sVol.addEventListener('input', () => {
  S.vol = +sVol.value; showVol(); readouts(); save();
  if (playing) gain.gain.setTargetAtTime(dbToLin(S.vol), ctx.currentTime, 0.01);
});

/* ---------- readouts ---------- */
function readouts() {
  const n = nearest(S.freq);
  $('#rNote').textContent = n.name + ' ' + (n.cents >= 0 ? '+' : '−') + Math.abs(n.cents) + '¢';
  const p = 1000 / S.freq;
  $('#rPer').textContent = p >= 100 ? p.toFixed(1) + ' ms' : p >= 1 ? p.toFixed(3) + ' ms' : (p * 1000).toFixed(1) + ' µs';
  const wl = C_AIR / S.freq;
  $('#rWl').textContent = wl >= 1 ? wl.toFixed(2) + ' m' : (wl * 100).toFixed(1) + ' cm';
  if (!playing) $('#rLvl').textContent = fmtDb(S.vol) + ' set';
}
const fmtDb = d => d <= -120 ? '−∞' : (d < 0 ? '−' : '+') + Math.abs(d).toFixed(1);
// while playing, Level shows the measured output (browser oscillators are band-limited,
// so square/saw peak and RMS differ slightly from the textbook values)
let lastLvl = 0;
function measure(t) {
  if (t - lastLvl < 150) return; lastLvl = t;
  let pk = 0, s = 0;
  for (let i = 0; i < tbuf.length; i++) { const v = tbuf[i], a = v < 0 ? -v : v; if (a > pk) pk = a; s += v * v; }
  $('#rLvl').textContent = fmtDb(20 * Math.log10(pk || 1e-9)) + ' pk · ' + fmtDb(10 * Math.log10(s / tbuf.length || 1e-12)) + ' rms';
}

/* ---------- oscilloscope ---------- */
const cv = $('#scope'), g = cv.getContext('2d');
const css = getComputedStyle(document.documentElement);
const C = k => css.getPropertyValue(k).trim();
const COL = { trace: C('--trace'), edge: C('--edge'), muted: C('--muted'), bg: C('--panel'), num: C('--f-num') };
let W = 0, H = 0, dpr = 1;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 3);
  const r = cv.getBoundingClientRect();
  W = Math.max(50, r.width); H = Math.max(50, r.height);
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
}
new ResizeObserver(resize).observe($('#scopeWrap'));

// ideal shapes (phase 0..1) used when stopped, so the screen previews the selected wave
const SHAPE = {
  sine: p => Math.sin(2 * Math.PI * p),
  square: p => p < 0.5 ? 1 : -1,
  triangle: p => p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4,
  sawtooth: p => p < 0.5 ? 2 * p : 2 * p - 2
};

function drawGrid(span) {
  g.strokeStyle = COL.edge; g.lineWidth = 1;
  for (let i = 1; i < 10; i++) {               // 10 horizontal divisions
    const x = Math.round(W * i / 10) + 0.5;
    g.globalAlpha = i === 5 ? 1 : 0.5;
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  }
  [0.25, 0.5, 0.75].forEach(k => {
    const y = Math.round(H * k) + 0.5;
    g.globalAlpha = k === 0.5 ? 1 : 0.5;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
  });
  g.globalAlpha = 1;
  g.font = '11px ' + COL.num; g.fillStyle = COL.muted;
  const dbs = d => (d < -0.05 ? '−' : '') + Math.abs(d).toFixed(1);
  // top edge = scope range
  g.textAlign = 'right'; g.textBaseline = 'top';
  g.fillText('top ' + dbs(20 * Math.log10(vScale)) + ' dBFS', W - 8, 6);
  // set peak level, top-left
  const pk = dbToLin(S.vol);
  g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillText('peak ' + dbs(S.vol) + ' dBFS  (' + pk.toFixed(3) + ')', 8, 6);
  if (pk > vScale * 1.001) {
    g.fillStyle = COL.trace; g.fillText('▲ exceeds scope range', 8, 21); g.fillStyle = COL.muted;
  }
  g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText(fmtDiv(span / 10) + '/div', W - 8, H - 6);
}
function fmtDiv(ms) { return ms >= 1 ? (ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)) + ' ms' : (ms * 1000).toFixed(0) + ' µs'; }

let vScale = 1;                              // signal value shown at the top edge
// Lanczos kernel lookup (|x| from 0 to 16 in 1/512 steps) for the scope's sinc reconstruction
const LZ_A = 16, LZ_RES = 512, LZ = new Float32Array(LZ_A * LZ_RES + 2);
for (let i = 0; i < LZ.length; i++) {
  const x = i / LZ_RES;
  LZ[i] = x === 0 ? 1 : x >= LZ_A ? 0 : (Math.sin(Math.PI * x) / (Math.PI * x)) * (Math.sin(Math.PI * x / LZ_A) / (Math.PI * x / LZ_A));
}
const yOf = v => H / 2 - v / vScale * (H / 2);

// draw a trace from per-pixel min/max columns: collapses to a plain line when the signal is
// slow, and becomes a filled band (like a real scope) when many cycles share one pixel
function drawCols(mn, mx, n, style, busy) {
  g.beginPath();
  for (let k = 0; k <= n; k++) {
    const x = k / n * W, y1 = yOf(mx[k]), y2 = yOf(mn[k]);
    k ? g.lineTo(x, y1) : g.moveTo(x, y1);
    if (y2 - y1 > 0.5) g.lineTo(x, y2);
  }
  g.strokeStyle = COL.trace;
  if (style === 'live') {
    // soft glow (cheap, unlike shadowBlur); skipped for dense traces where it would only cost frames
    if (!busy) { g.globalAlpha = 0.16; g.lineWidth = 7; g.stroke(); }
    g.globalAlpha = 1; g.lineWidth = 2; g.stroke();
  } else {
    g.globalAlpha = 0.35; g.lineWidth = 2; g.stroke(); g.globalAlpha = 1;
  }
}

let mnB = new Float32Array(0), mxB = new Float32Array(0);
function frame(now) {
  requestAnimationFrame(frame);
  if (!W) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  vScale = S.scopeRange === 'auto' ? dbToLin(S.vol) / 0.8 : dbToLin(+S.scopeRange);
  const sr = ctx ? ctx.sampleRate : 48000;
  const N = 32768, A = LZ_A;
  // screen span in seconds: fixed time base, or auto = fit N cycles
  let span = S.tb[0] === 'c' ? (S.freq < 2 ? 1 : +S.tb.slice(1)) / S.freq : +S.tb * 10 / 1000;
  span = Math.min(span, (N - 2 * A - 2) / sr);  // what the scope buffer can hold
  const n = Math.max(2, Math.round(W));         // one column per CSS pixel
  if (mnB.length !== n + 1) { mnB = new Float32Array(n + 1); mxB = new Float32Array(n + 1); }
  g.lineJoin = 'bevel'; g.lineCap = 'butt';
  drawGrid(span * 1000);

  if (playing && analyser) {
    analyser.getFloatTimeDomainData(tbuf);
    measure(now);
    const win = span * sr;
    // newest rising zero crossing that still leaves a full window after it,
    // located between samples for a rock-steady picture (free-runs if none fits)
    let t0 = Math.max(A, N - win - A - 1);
    for (let i = Math.floor(N - win - A - 1); i > A; i--) {
      const a = tbuf[i - 1], b = tbuf[i];
      if (a <= 0 && b > 0) { t0 = i - 1 + a / (a - b); break; }
    }
    if (win < n) {
      // fewer samples than pixels: reconstruct the continuous signal (what the DAC outputs)
      // with Lanczos-windowed sinc interpolation instead of joining samples with straight lines
      for (let k = 0; k <= n; k++) {
        const t = t0 + win * k / n, i0 = Math.floor(t);
        let v = 0;
        for (let j = i0 - A + 1; j <= i0 + A; j++) {
          const x = t - j;
          v += tbuf[j] * LZ[Math.round((x < 0 ? -x : x) * LZ_RES)];
        }
        mnB[k] = mxB[k] = v;
      }
    } else {
      // more samples than pixels: min/max of the samples behind each pixel
      for (let k = 0; k <= n; k++) {
        const s0 = Math.floor(t0 + win * k / n), s1 = Math.max(s0 + 1, Math.floor(t0 + win * (k + 1) / n));
        let lo = Infinity, hi = -Infinity;
        for (let i = s0; i < s1 && i < N; i++) { const v = tbuf[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
        mnB[k] = lo; mxB[k] = hi;
      }
    }
    drawCols(mnB, mxB, n, 'live', span * S.freq > 6);
  } else {
    // stopped: dimmed preview of the selected shape at the set level
    const a = dbToLin(S.vol), fn = SHAPE[S.wave], cyc = span * S.freq, cpp = cyc / n;
    const m = cpp < 0.02 ? 1 : Math.min(64, Math.ceil(cpp * 24));
    for (let k = 0; k <= n; k++) {
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < m; i++) {
        const v = a * fn(((k + i / m) * cpp) % 1);
        if (v < lo) lo = v; if (v > hi) hi = v;
      }
      mnB[k] = lo; mxB[k] = hi;
    }
    drawCols(mnB, mxB, n, 'preview');
  }
}

/* ---------- transport + keys ---------- */
$('#bPlay').onclick = () => playing ? stop() : play();
$('#bStop').onclick = stop;
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
  if (document.activeElement.tagName === 'BUTTON') document.activeElement.blur();
  e.preventDefault(); playing ? stop() : play();
});

/* ---------- init ---------- */
sVol.value = S.vol; showVol();
iA4.value = S.a4.toFixed(S.a4 % 1 ? 2 : 0);
setFreq(S.freq);
resize();
requestAnimationFrame(frame);
})();
