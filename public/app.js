// Mix Assistant web app: console-style channel strips. Talks to the booth bridge over a WebSocket.

const $ = (sel) => document.querySelector(sel);
const NEG_INF = -999; // how the bridge encodes -Infinity in JSON
const CAP_H = 34; // must match .cap height in style.css
const SCALE = [10, 5, 0, -5, -10, -20, -30, -50];

let ws;
let latest = null;
const strips = new Map(); // key -> parts
const busy = new Set(); // controls being touched: incoming updates don't move them

// ---------- X Air fader law (same as the mixer) ----------
function floatToDb(f) {
  if (f <= 0) return -Infinity;
  if (f >= 0.5) return f * 40 - 30;
  if (f >= 0.25) return f * 80 - 50;
  if (f >= 0.0625) return f * 160 - 70;
  return f * 480 - 90;
}
function dbToFloat(db) {
  if (db <= -90) return 0;
  if (db >= -10) return (db + 30) / 40;
  if (db >= -30) return (db + 50) / 80;
  if (db >= -60) return (db + 70) / 160;
  return (db + 90) / 480;
}
function fmtDb(db) {
  if (db === NEG_INF || db === -Infinity || db <= -89.5) return '-∞';
  const r = Math.round(db * 10) / 10;
  if (r === 0) return '0.0';
  return `${r > 0 ? '+' : ''}${r.toFixed(1)}`;
}
const meterPct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
const posCss = (pos) => `calc(${pos} * (100% - ${CAP_H}px) + ${CAP_H / 2}px)`;

// ---------- plumbing ----------
function send(cmd) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(cmd));
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'auth-required') {
      const saved = loadPin();
      if (saved) send({ type: 'auth', pin: saved });
      else showAuth('');
      return;
    }
    if (msg.type === 'auth-failed') {
      savePin(null);
      showAuth(msg.retryIn ? `Too many tries. Wait ${msg.retryIn} seconds, then try again.` : "That PIN didn't match. Check the booth Mac and try again.");
      return;
    }
    if (msg.type === 'hello') {
      if (pendingPin) savePin(pendingPin);
      pendingPin = null;
      $('#auth').hidden = true;
      return;
    }
    if (msg.type !== 'state') return;
    latest = msg;
    render(latest);
  };
  ws.onclose = () => {
    setPill($('#conn'), 'danger', 'Bridge offline — retrying…');
    setTimeout(connect, 1500);
  };
}
// ---------- PIN ----------
let pendingPin = null;
function loadPin() {
  try {
    return localStorage.getItem('mixPin');
  } catch {
    return null;
  }
}
function savePin(pin) {
  try {
    if (pin) localStorage.setItem('mixPin', pin);
    else localStorage.removeItem('mixPin');
  } catch {
    /* private browsing: PIN just won't be remembered */
  }
}
function showAuth(message) {
  $('#auth').hidden = false;
  $('#authMsg').textContent = message;
  $('#pinInput').value = '';
  $('#pinInput').focus();
}
$('#authForm').addEventListener('submit', (e) => {
  e.preventDefault();
  pendingPin = $('#pinInput').value.trim();
  if (pendingPin) send({ type: 'auth', pin: pendingPin });
});

function setPill(el, kind, text) {
  el.className = `pill pill-${kind}`;
  el.textContent = text;
}
function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c);
  return n;
}

// ---------- fader (relative drag: touching never makes it jump) ----------
function makeFader(key, onMove) {
  const cap = el('div', { class: 'cap' });
  const track = el('div', { class: 'track', role: 'slider', 'aria-label': 'Fader' }, [
    el('div', { class: 'unity', style: `bottom:${posCss(0.75)}` }),
    cap,
  ]);
  const scale = el(
    'div',
    { class: 'scale' },
    [...SCALE.map((db) => el('span', { text: db > 0 ? `+${db}` : String(db), style: `bottom:${posCss(dbToFloat(db))}` })),
      el('span', { text: '∞', style: `bottom:${posCss(0)}` })],
  );
  let start = null;
  let pos = 0;
  track.addEventListener('pointerdown', (e) => {
    if (track.classList.contains('disabled')) return;
    track.setPointerCapture(e.pointerId);
    busy.add(key);
    track.classList.add('dragging');
    start = { y: e.clientY, pos, h: track.getBoundingClientRect().height - CAP_H };
  });
  track.addEventListener('pointermove', (e) => {
    if (!start) return;
    const next = Math.min(1, Math.max(0, start.pos + (start.y - e.clientY) / start.h));
    const q = Math.round(next * 1023) / 1023;
    if (q === pos) return;
    pos = q;
    cap.style.setProperty('--pos', pos);
    onMove(pos);
  });
  const end = () => {
    start = null;
    track.classList.remove('dragging');
    setTimeout(() => busy.delete(key), 400);
  };
  track.addEventListener('pointerup', end);
  track.addEventListener('pointercancel', end);
  return {
    scale,
    track,
    set(p) {
      if (busy.has(key)) return;
      pos = p;
      cap.style.setProperty('--pos', p);
    },
    get pos() {
      return pos;
    },
  };
}

// ---------- channel strip ----------
function buildStrip(key, { dca = false } = {}) {
  const dot = el('span', { class: 'dot' });
  const label = el('span');
  const lr = dca ? null : el('button', { class: 'key' });
  const readout = el('div', { class: 'readout' });
  const fader = makeFader(key, (pos) => {
    readout.textContent = fmtDb(floatToDb(pos));
    if (dca) send({ type: 'setDcaFader', n: Number(key.slice(4)), value: pos });
    else send({ type: 'setFader', id: key.slice(3), value: pos });
  });
  const meterFill = el('div', { class: 'fill' });
  const area = el('div', { class: 'fader-area' }, [fader.scale, fader.track, ...(dca ? [] : [el('div', { class: 'meter' }, [meterFill])])]);
  const mute = el('button', { class: 'key' }, []);
  const nm = el('div', { class: 'nm' });
  const rl = el('div', { class: 'rl' });
  const scribble = el('button', { class: 'scribble' }, [nm, rl]);
  const root = el('div', { class: 'strip' }, [
    el('div', { class: 'strip-top' }, [label, dca ? el('span') : dot]),
    ...(lr ? [lr] : []),
    area,
    readout,
    mute,
    scribble,
  ]);
  const parts = { root, dot, label, lr, readout, fader, meterFill, mute, nm, rl, scribble };
  strips.set(key, parts);
  (dca ? $('#dcas') : $('#strips')).append(root);

  if (dca) {
    const n = Number(key.slice(4));
    mute.addEventListener('click', () => send({ type: 'setDcaOn', n, on: !latest.dcas.find((d) => d.n === n).on }));
  } else {
    const id = key.slice(3);
    const row = () => latest.inventory.rows.find((r) => r.id === id);
    mute.addEventListener('click', () => send({ type: 'setOn', id, on: !row().on }));
    lr.addEventListener('click', () => !row().locked && send({ type: 'setLr', id, lr: !row().lr }));
    scribble.addEventListener('click', () => openDialog(id));
  }
  return parts;
}

const STATUS = {
  'in-use': ['ok', 'In use: named and has signal.'],
  silent: ['warn', 'Named, but no signal. Check battery, cable or receiver.'],
  'unlabeled-signal': ['warn', 'Signal on a channel with no name. What is it?'],
  unused: ['', 'Unused: no name, no signal.'],
};

function updateChannel(r) {
  const p = strips.get(`ch-${r.id}`) ?? buildStrip(`ch-${r.id}`);
  p.root.classList.toggle('unused', r.status === 'unused');
  p.root.classList.toggle('locked', r.locked);
  p.label.textContent = r.id === 'aux' ? 'AUX' : r.id;
  p.dot.className = `dot ${STATUS[r.status][0]}`;
  p.dot.title = STATUS[r.status][1];

  if (r.locked) {
    p.lr.textContent = '🔒 MON';
    p.lr.className = 'key lock';
    p.lr.title = 'Monitors only: kept out of the main speakers and effects';
  } else {
    p.lr.textContent = 'LR';
    p.lr.className = `key ${r.lr ? 'lr-on' : ''}`;
    p.lr.title = r.lr ? 'Assigned to main speakers' : 'Not in main speakers';
  }
  p.fader.set(r.fader);
  if (!busy.has(`ch-${r.id}`)) p.readout.textContent = fmtDb(r.faderDb);
  p.meterFill.style.height = `${meterPct(r.levelDb)}%`;
  p.mute.textContent = 'MUTE';
  p.mute.className = `key ${r.on ? '' : 'mute-on'}`;
  p.nm.textContent = r.name || (r.id === 'aux' ? 'Aux in' : `Ch ${r.id}`);
  p.rl.textContent = r.role === 'none' ? '—' : r.role === 'unknown' ? '? set role' : r.roleLabel.split(' (')[0];
  p.scribble.className = `scribble g-${r.group}`;
}

function updateDca(d) {
  const p = strips.get(`dca-${d.n}`) ?? buildStrip(`dca-${d.n}`, { dca: true });
  p.label.textContent = `DCA ${d.n}`;
  p.fader.set(d.fader);
  if (!busy.has(`dca-${d.n}`)) p.readout.textContent = fmtDb(d.faderDb);
  p.mute.textContent = 'MUTE';
  p.mute.className = `key ${d.on ? '' : 'mute-on'}`;
  p.nm.textContent = d.name || `DCA ${d.n}`;
  p.rl.textContent = 'Group';
  p.scribble.className = 'scribble g-dca';
}

// ---------- channel dialog ----------
let dlgId = null;
function openDialog(id) {
  dlgId = id;
  const r = latest.inventory.rows.find((x) => x.id === id);
  $('#dlgTitle').textContent = `${r.label}: ${r.name || '(no name)'}`;
  $('#dlgStatus').textContent = `${STATUS[r.status][1]} Currently treated as: ${r.roleLabel}${r.roleSource === 'confirmed' ? ' (confirmed)' : ''}.`;
  const sel = $('#dlgRole');
  sel.replaceChildren(el('option', { value: '', text: 'Auto (from name)' }));
  for (const [k, label] of Object.entries(latest.roles)) if (k !== 'none' && k !== 'unknown') sel.append(el('option', { value: k, text: label }));
  sel.value = r.roleSource === 'confirmed' ? r.role : '';
  $('#stripDialog').showModal();
}
$('#dlgRole').addEventListener('change', (e) => send({ type: 'setRole', id: dlgId, role: e.target.value || null }));

// ---------- page ----------
function render(s) {
  const st = s.status;
  $('#conn').title = `Mix Assistant ${st.version ?? ''}`;
  if (st.connected) setPill($('#conn'), 'ok', `Mixer: ${st.mixer?.name ?? 'connected'}`);
  else if (st.searching) setPill($('#conn'), 'warn', 'Looking for mixer…');
  else setPill($('#conn'), 'danger', 'Mixer offline');

  const g = s.clickGuard;
  const renamed = g.locked.filter((l) => l.renamed);
  if (!g.locked.length) setPill($('#lock'), 'warn', 'No click/guide channel found');
  else if (!g.allSafe) setPill($('#lock'), 'danger', 'Click/guide reaching house — fixing');
  else if (renamed.length) setPill($('#lock'), 'danger', `🔒 ${renamed.map((l) => `Ch ${l.id}`).join(', ')} renamed: still locked, please check`);
  else setPill($('#lock'), 'ok', `🔒 ${g.locked.map((l) => l.name).join(' & ')} locked to monitors`);
  $('#lock').title = g.protectedBuses?.length
    ? `Also kept off: ${g.protectedBuses.map((b) => b.name).join(', ')}`
    : 'Kept off the main speakers and effects';

  // On the booth Mac itself, show how iPads connect.
  if (s.pin || s.addresses?.length) {
    const addr = s.addresses?.[0]?.replace('http://', '');
    $('#share').hidden = false;
    $('#share').textContent = [addr && `iPads: ${addr}`, s.pin && `PIN ${s.pin}`].filter(Boolean).join(' · ');
    $('#share').title = s.addresses?.join('\n') ?? '';
  } else $('#share').hidden = true;

  const inv = s.inventory;
  const c = inv.counts;
  $('#summary').textContent =
    `${c.inUse} in use · ${c.unused} unused${c.unusedOpen ? ` (${c.unusedOpen} open)` : ''}` +
    (inv.tracks.present ? ` · Tracks ${inv.tracks.playing ? 'playing' : 'silent'}` : '');
  const issues = [];
  for (const r of inv.rows) {
    if (r.status === 'silent' && !r.locked && r.role !== 'track' && r.role !== 'walkin')
      issues.push(['warn', `⚠️ ${r.label} "${r.name}": named but no signal. Check battery, cable or receiver.`]);
    if (r.status === 'unlabeled-signal') issues.push(['warn', `❓ ${r.label}: signal on an unnamed channel. Tap its name strip to set what it is.`]);
    if (r.role === 'unknown' && r.roleSource !== 'confirmed')
      issues.push(['info', `❔ ${r.label} "${r.name}": couldn't tell what this is from its name. Tap its name strip.`]);
  }
  $('#issueCount').textContent = issues.length ? `${issues.length} to check` : '✓ All good';
  $('#issueCount').style.color = issues.length ? 'var(--warn)' : 'var(--ok)';
  if (!issues.length) issues.push(['ok', '✅ Nothing needs attention.']);
  $('#issues').replaceChildren(...issues.map(([k, t]) => el('li', { class: `lvl-${k}` }, [el('span', { class: 'msg', text: t })])));

  $('#alerts').replaceChildren(
    ...(s.alerts.length
      ? s.alerts.map((a) =>
          el('li', { class: `lvl-${a.level}` }, [
            el('span', { class: 'msg', text: a.message }),
            el('time', { text: new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
          ]),
        )
      : [el('li', { class: 'lvl-ok' }, [el('span', { class: 'msg', text: 'No alerts.' })])]),
  );

  if (s.walkin.length) {
    const fading = s.walkin.some((w) => w.fading);
    const on = s.walkin.some((w) => w.on);
    $('#walkinState').textContent = fading ? 'Walk-in: fading…' : on ? 'Walk-in: playing' : 'Walk-in: off';
  } else {
    $('#walkinState').textContent = 'No walk-in channel';
  }

  for (const r of inv.rows) updateChannel(r);
  for (const d of s.dcas) updateDca(d);
}

$('#muteUnused').addEventListener('click', () => send({ type: 'muteUnused' }));
$('#walkinOut').addEventListener('click', () => send({ type: 'walkin', action: 'out' }));
$('#walkinIn').addEventListener('click', () => send({ type: 'walkin', action: 'in' }));
$('#clearAlerts').addEventListener('click', () => send({ type: 'clearAlerts' }));

// Keep the screen awake where the browser allows it.
async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported here */
  }
}
document.addEventListener('click', keepAwake, { once: true });
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());

connect();
