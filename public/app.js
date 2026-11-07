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
      const saved = loadPin() ?? linkPin;
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
// Opened from the QR code on the booth Mac: the link carries the PIN. It stays in the address on
// purpose, so "Add to Home Screen" saves it and the home-screen icon signs in by itself every week.
// (On iPads, home-screen apps don't share storage with Safari, so the link is what carries it over.)
const standalone = window.navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;
let linkPin = null;
{
  const m = location.hash.match(/(?:^#|&)pin=(\d{4,12})(?:&|$)/);
  if (m) {
    linkPin = m[1];
    savePin(linkPin);
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
  if (!pendingPin) return;
  if (ws?.readyState !== 1) {
    $('#authMsg').textContent = "Can't reach the booth Mac yet. Check this device is on the same Wi-Fi; it will keep trying.";
    return;
  }
  send({ type: 'auth', pin: pendingPin });
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
  $('#dlgLock').hidden = !r.locked;
  $('#stripDialog').showModal();
}
$('#dlgRole').addEventListener('change', (e) => send({ type: 'setRole', id: dlgId, role: e.target.value || null }));
$('#dlgRelease').addEventListener('click', () => {
  send({ type: 'releaseLock', id: dlgId });
  $('#stripDialog').close();
});

// ---------- page ----------
function render(s) {
  const st = s.status;
  document.body.classList.toggle('offline', !st.connected);
  $('#offlineBar').hidden = st.connected || st.searching;
  if (st.searching) {
    $('#offlineBar').hidden = false;
    $('#offlineBar').textContent = 'Looking for the mixer. Make sure the XR18 is on and this Mac is on the same network.';
  } else $('#offlineBar').textContent = "The mixer isn't connected. Controls are paused until it's back.";
  if (s.automix) renderAuto(s.automix);
  $('#conn').title = `Mix Assistant ${st.version ?? ''}`;
  const via = st.path && (st.path.kind === 'wifi' || st.path.kind === 'cable') ? ` · ${st.path.label}` : '';
  if (st.connected) setPill($('#conn'), 'ok', `Mixer: ${st.mixer?.name ?? 'connected'}${via}`);
  else if (st.searching) setPill($('#conn'), 'warn', 'Looking for mixer…');
  else setPill($('#conn'), 'danger', 'Mixer offline');

  const g = s.clickGuard;
  const renamed = g.locked.filter((l) => l.renamed);
  if (!g.locked.length) setPill($('#lock'), 'warn', 'No click/guide channel found');
  else if (!g.allSafe) setPill($('#lock'), 'danger', 'Click/guide reaching house — fixing');
  else if (renamed.length) setPill($('#lock'), 'danger', `🔒 ${renamed.map((l) => (l.id === 'aux' ? 'Aux 17/18' : `Ch ${l.id}`)).join(', ')} renamed: still locked, please check`);
  else if (g.unsure?.length) setPill($('#lock'), 'warn', `🔒 Locked, but aux ${[...new Set(g.unsure.map((u) => u.bus))].join(', ')} needs a name`);
  else setPill($('#lock'), 'ok', `🔒 ${g.locked.map((l) => l.name).join(' & ')} locked to monitors`);
  $('#lock').title = g.protectedBuses?.length
    ? `Also kept off: ${g.protectedBuses.map((b) => b.name).join(', ')}`
    : 'Kept off the main speakers and effects';

  // On the booth Mac itself, offer the QR code that connects an iPad.
  $('#share').hidden = !s.addresses?.length;
  if (s.addresses?.length) {
    $('#share').textContent = '📱 Connect an iPad';
    renderConnect(s);
  }

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
    if (r.offCenter)
      issues.push(['info', `↔️ ${r.label} "${r.name}" is panned ${r.pan < 0.5 ? 'left' : 'right'}. Both speakers play the same mix, so panning does nothing useful here and makes it about 3 dB quieter. Centre it in the X Air app.`]);
    if (r.role === 'unknown' && r.roleSource !== 'confirmed')
      issues.push(['info', `❔ ${r.label} "${r.name}": couldn't tell what this is from its name. Tap its name strip.`]);
  }
  const setupLeft = renderChecklist(s.checklist);
  const parts = [setupLeft ? `Setup: ${setupLeft} left` : '', issues.length ? `${issues.length} to check` : ''].filter(Boolean);
  $('#issueCount').textContent = parts.length ? parts.join(' · ') : '✓ All good';
  $('#issueCount').style.color = parts.length ? 'var(--warn)' : 'var(--ok)';
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
    const sound = s.walkin.some((w) => s.inventory.rows.find((r) => r.id === w.id)?.signal);
    $('#walkinState').textContent = fading ? 'Music channel: fading…' : !on ? 'Music channel: off.' : sound ? 'Music channel: playing in the room.' : 'Music channel is up, but no music is reaching the mixer. Check the Mac\'s sound output.';
  } else {
    $('#walkinState').textContent = 'No music channel found. Name the Spotify channel "Spotify" or "Pre/Post" in the X Air app.';
  }
  renderMusic(s);
  renderMac(s);
  renderPa(s);

  for (const r of inv.rows) updateChannel(r);
  for (const d of s.dcas) updateDca(d);
}

$('#muteUnused').addEventListener('click', () => {
  const ready = latest?.unusedReady;
  const list = latest?.unused ?? [];
  if (!ready) $('#unusedText').textContent = 'Still checking which channels are in use. Give it about 15 seconds after the mixer connects.';
  else if (!list.length) $('#unusedText').textContent = 'Every channel without a name is already muted.';
  else $('#unusedText').textContent = `These have no name and no sound: ${list.map((u) => u.label).join(', ')}. Muting them cuts their hiss.`;
  $('#unusedConfirm').hidden = !ready || !list.length;
  $('#unusedDialog').dataset.ids = JSON.stringify(list.map((u) => u.id));
  $('#unusedDialog').showModal();
});
$('#unusedDialog').addEventListener('close', () => {
  if ($('#unusedDialog').returnValue === 'mute') send({ type: 'muteUnused', ids: JSON.parse($('#unusedDialog').dataset.ids || '[]') });
});

// ---------- Auto view ----------
const MODE_LABEL = { walkin: 'Before / after', worship: 'Worship', talkover: 'Talking over music', speaking: 'Speaking', idle: 'Quiet' };
function renderAuto(a) {
  for (const b of document.querySelectorAll('.mode')) {
    const m = b.dataset.mode;
    b.classList.toggle('now', a.mode === m && !a.modeLocked);
    b.classList.toggle('picked', a.modeLocked === m);
  }
  const autoOn = !a.modeLocked && a.settings.autoModes;
  $('#modeAuto').classList.toggle('on', autoOn);
  $('#modeAuto').textContent = autoOn ? 'Automatic ✓' : 'Go automatic';
  $('#modeNote').textContent = a.modeLocked
    ? `You set ${MODE_LABEL[a.modeLocked]}. It stays there until you tap "Go automatic".`
    : !a.settings.autoModes
      ? 'Automatic mode changes are off. Tap a mode to set it.'
      : a.candidate && a.candidate !== a.mode
        ? `Listening… looks like ${MODE_LABEL[a.candidate]}.`
        : 'Changes by itself from what it hears. Tap a mode to set it yourself.';

  const lines = [];
  for (const c of a.channels) {
    const role = latest.inventory.rows.find((r) => r.id === c.id)?.group;
    if (c.mutedByAuto) lines.push(['down', c.name, 'down in the room for the sermon']);
    else if (role === 'speech' && a.settings.speechAutomix) {
      if (c.offsetDb > -1) lines.push(['up', c.name, c.active ? 'up · talking' : 'up']);
      else lines.push(['down', c.name, `${c.offsetDb.toFixed(0)} dB · waiting`]);
    }
  }
  const ducked = a.channels.filter((c) => ['band', 'tracks'].includes(latest.inventory.rows.find((r) => r.id === c.id)?.group) && c.offsetDb < -1);
  if (ducked.length) lines.push(['down', 'Band and tracks', `${Math.round(Math.min(...ducked.map((c) => c.offsetDb)))} dB under talking`]);
  if (!lines.length) lines.push(['', 'Nothing to adjust right now', '']);
  $('#doing').replaceChildren(
    ...lines.map(([k, name, v]) => el('li', { class: k }, [el('span', { text: name }), el('span', { class: 'v', text: v })])),
  );
  const set = (sel, v) => {
    if (document.activeElement !== $(sel)) $(sel).checked = !!v;
  };
  set('#optSpeech', a.settings.speechAutomix);
  set('#optDuck', a.settings.duckMusic);
  set('#optSingers', a.settings.muteSingersWhenSpeaking);
  set('#optModes', a.settings.autoModes);
}
for (const b of document.querySelectorAll('.mode')) b.addEventListener('click', () => send({ type: 'setMode', mode: b.dataset.mode }));
$('#modeAuto').addEventListener('click', () => {
  send({ type: 'setMode', mode: 'auto' });
  if (!latest?.automix?.settings.autoModes) send({ type: 'automix', settings: { autoModes: true } });
});
for (const [sel, key] of [['#optSpeech', 'speechAutomix'], ['#optDuck', 'duckMusic'], ['#optSingers', 'muteSingersWhenSpeaking'], ['#optModes', 'autoModes']]) {
  $(sel).addEventListener('change', (e) => send({ type: 'automix', settings: { [key]: e.target.checked } }));
}

// ---------- tabs ----------
const TABS = { auto: ['#tabAuto', '#autoView'], mixer: ['#tabMixer', '#console'], pa: ['#tabPa', '#paView'] };
function showTab(name) {
  if (!TABS[name]) name = 'auto';
  for (const [k, [tab, view]] of Object.entries(TABS)) {
    $(view).hidden = k !== name;
    $(tab).classList.toggle('active', k === name);
    $(tab).setAttribute('aria-selected', String(k === name));
  }
  try {
    localStorage.setItem('mixTab', name);
  } catch {
    /* fine */
  }
}
for (const k of Object.keys(TABS)) $(TABS[k][0]).addEventListener('click', () => showTab(k));
try {
  showTab(localStorage.getItem('mixTab') || 'auto');
} catch {
  showTab('auto');
}

// ---------- PA setup ----------
// Gain check: each channel's loudest moment over the last few seconds, against the target window.
const GAIN_HOLD_MS = 3000;
const gainPeaks = new Map(); // id -> { db, at }
const floorSamples = new Map(); // id -> [{ db, at }] for the hiss check
const pct = (db) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

function gainVerdict(peak) {
  if (peak === null || peak < -50) return ['idle', 'Waiting for sound…'];
  if (peak > -3) return ['clip', `Too hot: lower the gain about ${Math.round(peak + 15)} dB`];
  if (peak > -9) return ['hot', `A bit hot: lower about ${Math.round(peak + 15)} dB`];
  if (peak >= -21) return ['good', 'Good'];
  return ['low', `Too quiet: raise the gain about ${Math.round(-15 - peak)} dB`];
}

function renderPa(s) {
  const now = Date.now();
  const rows = s.inventory.rows.filter((r) => r.name && !r.locked && r.role !== 'none');
  // Gain check
  const items = rows.map((r) => {
    const prev = gainPeaks.get(r.id);
    let peak = r.levelDb;
    if (prev && now - prev.at < GAIN_HOLD_MS && prev.db >= r.levelDb) peak = prev.db;
    else gainPeaks.set(r.id, { db: r.levelDb, at: now });
    const [kind, text] = gainVerdict(peak);
    const fill = el('div', { class: 'fill' });
    fill.style.width = `${pct(peak)}%`;
    const target = el('div', { class: 'target' });
    target.style.left = `${pct(-21)}%`;
    target.style.width = `${pct(-9) - pct(-21)}%`;
    return el('li', {}, [
      el('span', { class: 'gname', text: r.name }),
      el('div', { class: 'gbar' }, [target, fill]),
      el('span', { class: 'gval', text: peak < -50 ? '–' : `${peak.toFixed(0)} dB` }),
      el('span', { class: `gverdict v-${kind}`, text }),
    ]);
  });
  $('#gainList').replaceChildren(...(items.length ? items : [el('li', {}, [el('span', { text: 'No named channels yet. Name them in the X Air app.' })])]));

  // Hiss check: the quietest level of each open channel over the last 10 seconds.
  const hissy = [];
  for (const r of s.inventory.rows) {
    if (r.locked) continue;
    const list = (floorSamples.get(r.id) ?? []).filter((x) => now - x.at < 10000);
    if (!list.length || now - list[list.length - 1].at > 400) list.push({ db: r.levelDb, at: now });
    floorSamples.set(r.id, list);
    const floor = Math.min(...list.map((x) => x.db));
    // Hiss sits roughly between -62 and -40 dB. Louder than that, something is still making sound.
    if (r.on && list.length > 15 && floor > -62) hissy.push([r, floor]);
  }
  const playing = hissy.filter(([, f]) => f > -40);
  const hiss = hissy.filter(([, f]) => f <= -40);
  $('#hissList').replaceChildren(
    ...hiss.map(([r, f]) => el('li', { class: 'lvl-warn' }, [el('span', { class: 'msg', text: `${r.label} ${r.name || '(no name)'}: hiss at ${f.toFixed(0)} dB${r.name ? '' : ' · unused? mute it'}` })])),
    ...(playing.length
      ? [el('li', { class: 'lvl-info' }, [el('span', { class: 'msg', text: `Still making sound, so it can't be checked yet: ${playing.map(([r]) => r.name || r.label).join(', ')}. Stop them and wait 10 seconds.` })])]
      : []),
    ...(!hissy.length ? [el('li', { class: 'lvl-ok' }, [el('span', { class: 'msg', text: 'No hissy open channels right now (checked when the room is quiet).' })])] : []),
  );

  // Knob positions
  const pa = s.pa;
  if (pa) {
    $('#paVenue').textContent = pa.venueName ? `Venue: ${pa.venueName}. Settings below are saved for this venue.` : 'No venue chosen: settings are saved as the default. Choose or save a venue on the booth Mac to keep them per venue.';
    const form = $('#paForm');
    if (!form.dataset.built) {
      form.dataset.built = '1';
      for (const f of pa.fields) form.append(el('label', {}, [f.label, el('input', { id: `pa-${f.id}`, maxlength: '40', autocomplete: 'off' })]));
      form.append(el('div', { class: 'actions' }, [el('button', { class: 'btn', type: 'submit', text: 'Save PA settings' })]));
    }
    for (const f of pa.fields) {
      const input = $(`#pa-${f.id}`);
      if (document.activeElement !== input && !input.dataset.dirty) input.value = pa.values[f.id] ?? '';
    }
    $('#paSaved').textContent = pa.values.savedAt ? `Last saved ${new Date(pa.values.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Not saved yet.';
  }

  // Test noise is played by the booth Mac itself.
  const onMac = !!s.mac;
  $('#noiseBtn').disabled = !onMac;
  if (!onMac) $('#noiseNote').textContent = 'Test noise plays from the booth Mac: open the PA setup tab there to start it.';
}
$('#paForm').addEventListener('input', (e) => {
  if (e.target.tagName === 'INPUT') e.target.dataset.dirty = '1';
});
$('#paForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const fields = {};
  for (const f of latest?.pa?.fields ?? []) {
    const input = $(`#pa-${f.id}`);
    fields[f.id] = input.value;
    delete input.dataset.dirty;
  }
  send({ type: 'savePa', fields });
});

// Pink noise from the Mac's speakers output (which feeds the XR18 music channel), about -20 dBFS.
let noise = null;
function stopNoise() {
  if (!noise) return;
  clearTimeout(noise.timer);
  noise.ctx.close();
  noise = null;
  $('#noiseBtn').textContent = 'Play test noise';
  $('#noiseBtn').classList.remove('playing');
}
$('#noiseBtn').addEventListener('click', async () => {
  if (noise) return stopNoise();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const seconds = 8;
  const buf = ctx.createBuffer(2, ctx.sampleRate * seconds, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Paul Kellet's pink noise filter.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  const gain = ctx.createGain();
  gain.gain.value = 0.5; // measured: about -20 dBFS RMS, peaks about -7 dBFS
  src.connect(gain).connect(ctx.destination);
  src.start();
  noise = { ctx, timer: setTimeout(stopNoise, 90000) }; // never left running by accident
  $('#noiseBtn').textContent = 'Stop test noise';
  $('#noiseBtn').classList.add('playing');
});
// ---------- connect an iPad (QR code, booth Mac only) ----------
let qrFor = '';
function connectLink(s) {
  const base = s.addresses?.[0];
  if (!base) return null;
  return s.pin ? `${base}/#pin=${s.pin}` : `${base}/`;
}
function renderConnect(s) {
  const link = connectLink(s);
  if (!link || link === qrFor) return;
  qrFor = link;
  try {
    const qr = window.qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    $('#qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  } catch {
    $('#qr').textContent = '';
  }
  const addr = s.addresses[0].replace('http://', '');
  $('#connectFallback').textContent = `No camera? In Safari on the iPad, go to ${addr}${s.pin ? ` and enter PIN ${s.pin}` : ''}.`;
}
function openConnect() {
  if (latest) renderConnect(latest);
  $('#connectDialog').showModal();
}
$('#share').addEventListener('click', openConnect);
$('#connectBtn').addEventListener('click', openConnect);

// One-time hint on an iPad that opened the QR link in Safari.
if (linkPin && !standalone) {
  let seen = false;
  try {
    seen = localStorage.getItem('mixHomeTipSeen') === '1';
  } catch {
    /* fine */
  }
  if (!seen) $('#homeTip').hidden = false;
}
$('#homeTipOk').addEventListener('click', () => {
  $('#homeTip').hidden = true;
  try {
    localStorage.setItem('mixHomeTipSeen', '1');
  } catch {
    /* fine */
  }
});

// ---------- setup checklist (every device) ----------
let manualKey = '';
/** Draws the checklist; returns how many items still need attention. */
function renderChecklist(c) {
  if (!c) return 0;
  $('#autoChecks').replaceChildren(
    ...c.auto.map((i) =>
      el('li', { class: i.ok ? 'ok' : 'bad' }, [
        el('span', { class: 'mark', text: i.ok ? '✓' : '!' }),
        el('span', { class: 'msg', text: i.label }),
        el('span', { class: 'detail', text: i.detail ?? '' }),
      ]),
    ),
  );
  const key = JSON.stringify(c.manual);
  if (key !== manualKey) {
    manualKey = key;
    $('#manualChecks').replaceChildren(
      ...c.manual.map((i) => {
        const box = el('input', { type: 'checkbox', id: `chk-${i.id}` });
        box.checked = i.done;
        box.addEventListener('change', () => send({ type: 'checkItem', id: i.id, done: box.checked }));
        return el('li', { class: i.done ? 'done' : '' }, [el('label', { for: `chk-${i.id}` }, [box, el('span', { text: i.label })])]);
      }),
    );
  }
  $('#venueNote').hidden = !c.venue;
  if (c.venue) $('#venueNote').textContent = `${c.venue.name}${c.venue.notes ? `: ${c.venue.notes}` : ''}`;
  const total = c.auto.length + c.manual.length;
  const done = c.auto.filter((i) => i.ok).length + c.manual.filter((i) => i.done).length;
  $('#checkProgress').textContent = `${done} of ${total} done`;
  return total - done;
}

// ---------- this Mac (only shown on the booth Mac's own screen) ----------
let confirmUpdate = false;
let venuesKey = '';
function renderConnection(s) {
  const m = s.mac;
  const c = m.connection;
  const sel = $('#connPref');
  if (!sel.options.length) for (const [k, label] of Object.entries(c.modes)) sel.append(el('option', { value: k, text: k === 'auto' ? `${label} (recommended)` : label }));
  if (document.activeElement !== sel) sel.value = c.mode;
  sel.disabled = c.fixed;
  const p = s.status.path;
  const now = !s.status.connected ? 'Not connected to the mixer right now.' : p && p.kind !== 'local' ? `Using ${p.label}${p.port ? ` (${p.port})` : ''} to reach the mixer at ${p.mixerIp}.` : `Connected to the mixer at ${s.status.host}.`;
  $('#connStatus').textContent = c.fixed
    ? `Set to a fixed mixer address in config.json. ${now}`
    : c.mode !== 'auto' && !c.preferenceMet
      ? `${now} The ${c.mode === 'cable' ? 'cable' : 'Wi-Fi'} connection isn't reaching the mixer, so it's using what works.`
      : now;

  // Venues
  const vkey = JSON.stringify([m.venues, m.venue]);
  if (vkey !== venuesKey) {
    venuesKey = vkey;
    const vs = $('#venueSel');
    vs.replaceChildren(el('option', { value: '', text: m.venues.length ? 'No venue chosen' : 'No venues saved yet' }), ...m.venues.map((v, i) => el('option', { value: String(i), text: v.name })));
    vs.value = m.venue === null ? '' : String(m.venue);
    const v = m.venue === null ? null : m.venues[m.venue];
    $('#venueEditSummary').textContent = v ? `Edit venue "${v.name}"` : 'Save this setup as a venue';
    if (document.activeElement !== $('#venueName')) $('#venueName').value = v?.name ?? '';
    if (document.activeElement !== $('#venueNotes')) $('#venueNotes').value = v?.notes ?? '';
    $('#venueDelete').hidden = !v;
  }
}
$('#connPref').addEventListener('change', (e) => send({ type: 'setConnection', mode: e.target.value }));
$('#venueSel').addEventListener('change', (e) => send({ type: 'selectVenue', index: e.target.value === '' ? null : Number(e.target.value) }));
$('#venueForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const idx = latest?.mac?.venue;
  const sameName = idx !== null && idx !== undefined && latest.mac.venues[idx]?.name === $('#venueName').value.trim();
  send({ type: 'saveVenue', index: sameName ? idx : undefined, name: $('#venueName').value, notes: $('#venueNotes').value, connection: $('#connPref').value });
  venuesKey = '';
});
$('#venueDelete').addEventListener('click', () => {
  const idx = latest?.mac?.venue;
  if (idx === null || idx === undefined) return;
  send({ type: 'deleteVenue', index: idx });
  venuesKey = '';
});

function renderMac(s) {
  const m = s.mac;
  $('#macCard').hidden = !m;
  if (!m) return;
  renderConnection(s);
  const u = m.update ?? {};
  $('#macVersion').textContent = `Mix Assistant ${u.current ?? ''}`;
  $('#updCheck').disabled = !!u.checking || !!u.updating;
  $('#updCheck').textContent = u.checking ? 'Checking…' : 'Check for updates';
  $('#updInstall').hidden = !u.available || u.updating;
  $('#updInstall').textContent = confirmUpdate ? `Tap again to update to ${u.latest}` : `Update to ${u.latest}`;
  $('#updNote').textContent = u.updating
    ? `${u.step ?? 'Updating'}… Mix Assistant restarts by itself; the mixer keeps running.`
    : u.error
      ? u.error
      : u.available
        ? "Updating takes about a minute and restarts Mix Assistant (the mixer keeps running). Don't update during a service."
        : u.latest
          ? 'Up to date.'
          : '';
  $('#practiceBtn').textContent = m.practice ? 'Stop practice mode' : 'Start practice mode';
  $('#practiceLink').hidden = !m.practice;
  $('#practiceLink').href = `http://localhost:${m.practicePort ?? 8081}`;
}
$('#updCheck').addEventListener('click', () => send({ type: 'checkUpdate' }));
$('#updInstall').addEventListener('click', () => {
  if (!confirmUpdate) {
    confirmUpdate = true;
    setTimeout(() => (confirmUpdate = false), 5000);
    if (latest) renderMac(latest);
    return;
  }
  confirmUpdate = false;
  send({ type: 'installUpdate' });
});
$('#practiceBtn').addEventListener('click', () => {
  const on = !latest?.mac?.practice;
  send({ type: 'practice', on });
  if (on) setTimeout(() => window.open(`http://localhost:${latest?.mac?.practicePort ?? 8081}`, '_blank'), 2500);
});

// ---------- walk-in player ----------
let plKey = '';
function renderMusic(s) {
  const m = s.music;
  const pls = s.playlists ?? [];
  if (!m || !m.available) {
    $('#npTrack').textContent = 'Music control works on the booth Mac';
    $('#npArtist').textContent = '';
  } else if (!m.running) {
    $('#npTrack').textContent = `${m.label} isn't open`;
    $('#npArtist').textContent = '"Fade music in" opens it';
  } else {
    $('#npTrack').textContent = m.track || (m.playing ? 'Playing' : 'Paused');
    $('#npArtist').textContent = [m.artist, m.playing ? '' : 'paused'].filter(Boolean).join(' · ');
  }
  const warn = m?.error || (m && m.internet === false ? `The Mac has no internet, so ${m.label} can only play downloaded playlists.` : '');
  $('#musicWarn').hidden = !warn;
  $('#musicWarn').textContent = warn || '';
  $('#mPlay').textContent = m?.playing ? '⏸' : '▶';
  const key = JSON.stringify(pls);
  if (key !== plKey) {
    plKey = key;
    const sel = $('#plSelect');
    const keep = sel.value;
    sel.replaceChildren(el('option', { value: '', text: "Whatever's loaded in the player" }), ...pls.map((p, i) => el('option', { value: String(i), text: p.name })));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    else if (pls.length) sel.value = '0';
    $('#plList').replaceChildren(
      ...pls.map((p, i) => {
        const rm = el('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Remove' });
        rm.addEventListener('click', () => send({ type: 'removePlaylist', index: i }));
        return el('li', {}, [el('span', { text: p.name }), rm]);
      }),
    );
  }
}
$('#walkinStart').addEventListener('click', () => {
  const v = $('#plSelect').value;
  send({ type: 'walkinStart', playlist: v === '' ? null : Number(v) });
});
$('#walkinEnd').addEventListener('click', () => send({ type: 'walkinEnd' }));
$('#mPrev').addEventListener('click', () => send({ type: 'music', action: 'previous' }));
$('#mNext').addEventListener('click', () => send({ type: 'music', action: 'next' }));
$('#mPlay').addEventListener('click', () => send({ type: 'music', action: latest?.music?.playing ? 'pause' : 'play' }));
$('#plForm').addEventListener('submit', (e) => {
  e.preventDefault();
  send({ type: 'addPlaylist', name: $('#plName').value, link: $('#plLink').value });
  $('#plName').value = '';
  $('#plLink').value = '';
});
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
