// Mix Assistant web app. Talks to the booth bridge over a WebSocket.

const $ = (sel) => document.querySelector(sel);
const FADER_MIN = -60; // slider bottom = off (-inf)
const NEG_INF = -999; // how the bridge encodes -Infinity in JSON

let ws;
let latest = null;
const stripEls = new Map();
const dcaEls = new Map();
const busy = new Set(); // controls the user is touching right now: don't overwrite them

function send(cmd) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(cmd));
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (e) => {
    latest = JSON.parse(e.data);
    render(latest);
  };
  ws.onclose = () => {
    setPill($('#conn'), 'danger', 'Bridge offline — retrying…');
    setTimeout(connect, 1500);
  };
}

function setPill(el, kind, text) {
  el.className = `pill pill-${kind}`;
  el.textContent = text;
}

function fmtDb(db) {
  if (db <= FADER_MIN || db === NEG_INF) return '-∞';
  const r = Math.round(db * 10) / 10;
  if (r === 0) return '0.0';
  return `${r > 0 ? '+' : ''}${r.toFixed(1)}`;
}

function meterPct(db) {
  // -60 dB .. 0 dB -> 0..100 %
  return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
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

function guardBusy(input, key) {
  const on = () => busy.add(key);
  const off = () => setTimeout(() => busy.delete(key), 300);
  input.addEventListener('pointerdown', on);
  input.addEventListener('focus', on);
  input.addEventListener('pointerup', off);
  input.addEventListener('blur', off);
  input.addEventListener('change', off);
}

// ---------- channel strips ----------

function buildStrip(row, roles) {
  const name = el('div', { class: 'strip-name' });
  const meter = el('div');
  const roleSel = el('select', { 'aria-label': 'Channel role' });
  roleSel.append(el('option', { value: '', text: 'Auto (from name)' }));
  for (const [k, label] of Object.entries(roles)) if (k !== 'none' && k !== 'unknown') roleSel.append(el('option', { value: k, text: label }));
  roleSel.addEventListener('change', () => send({ type: 'setRole', id: row.id, role: roleSel.value || null }));
  guardBusy(roleSel, `role-${row.id}`);

  const fader = el('input', { type: 'range', min: String(FADER_MIN), max: '10', step: '0.5', 'aria-label': 'Fader' });
  const out = el('output');
  fader.addEventListener('input', () => {
    out.textContent = fmtDb(Number(fader.value));
    const db = Number(fader.value) <= FADER_MIN ? -Infinity : Number(fader.value);
    send({ type: 'setFader', id: row.id, db: db === -Infinity ? -90 : db });
  });
  guardBusy(fader, `fader-${row.id}`);

  const mute = el('button', { class: 'btn btn-ghost' });
  mute.addEventListener('click', () => {
    const r = latest.inventory.rows.find((x) => x.id === row.id);
    send({ type: 'setOn', id: row.id, on: !r.on });
  });
  const lr = el('button', { class: 'btn btn-ghost' });
  lr.addEventListener('click', () => {
    const r = latest.inventory.rows.find((x) => x.id === row.id);
    send({ type: 'setLr', id: row.id, lr: !r.lr });
  });

  const badges = el('div', { class: 'badges' });
  const root = el('div', { class: 'strip' }, [
    el('div', { class: 'strip-head' }, [name, el('span', { class: 'strip-id', text: row.label })]),
    badges,
    el('div', { class: 'meter' }, [meter]),
    roleSel,
    el('div', { class: 'fader-row' }, [fader, out]),
    el('div', { class: 'strip-buttons' }, [mute, lr]),
  ]);
  const parts = { root, name, meter, roleSel, fader, out, mute, lr, badges };
  stripEls.set(row.id, parts);
  $('#strips').append(root);
  return parts;
}

const STATUS_BADGE = {
  'in-use': ['ok', 'In use'],
  silent: ['warn', 'Named, no signal'],
  'unlabeled-signal': ['warn', 'Signal, no name'],
  unused: ['', 'Unused'],
};

function updateStrip(row, roles) {
  const p = stripEls.get(row.id) ?? buildStrip(row, roles);
  p.root.classList.toggle('locked', row.locked);
  p.root.classList.toggle('unused', row.status === 'unused');
  p.name.textContent = row.name || '(no name)';
  p.meter.style.width = `${meterPct(row.levelDb)}%`;

  const [kind, text] = STATUS_BADGE[row.status];
  const badges = [[kind, text], ['', row.roleLabel]];
  if (row.roleSource === 'confirmed') badges.push(['ok', 'Confirmed']);
  if (row.locked) badges.push([row.lr || row.fxSends.some((v) => v > 0) ? 'danger' : 'ok', '🔒 Monitors only']);
  p.badges.replaceChildren(...badges.map(([k, t]) => el('span', { class: `badge ${k}`, text: t })));

  if (!busy.has(`role-${row.id}`)) p.roleSel.value = row.roleSource === 'confirmed' ? row.role : '';
  if (!busy.has(`fader-${row.id}`)) {
    const db = row.faderDb === NEG_INF ? FADER_MIN : Math.max(FADER_MIN, row.faderDb);
    p.fader.value = String(db);
    p.out.textContent = fmtDb(db);
  }
  p.mute.textContent = row.on ? 'Mute' : 'Muted';
  p.mute.className = `btn ${row.on ? 'btn-ghost' : 'mute-on'}`;
  p.lr.textContent = row.locked ? 'Main: locked off' : row.lr ? 'Main: on' : 'Main: off';
  p.lr.disabled = row.locked;
}

// ---------- DCAs ----------

function updateDca(d) {
  let p = dcaEls.get(d.n);
  if (!p) {
    const name = el('strong');
    const fader = el('input', { type: 'range', min: String(FADER_MIN), max: '10', step: '0.5' });
    const out = el('output');
    const mute = el('button', { class: 'btn btn-ghost btn-small' });
    fader.addEventListener('input', () => {
      out.textContent = fmtDb(Number(fader.value));
      send({ type: 'setDcaFader', n: d.n, db: Number(fader.value) <= FADER_MIN ? -90 : Number(fader.value) });
    });
    guardBusy(fader, `dca-${d.n}`);
    mute.addEventListener('click', () => {
      const cur = latest.dcas.find((x) => x.n === d.n);
      send({ type: 'setDcaOn', n: d.n, on: !cur.on });
    });
    const root = el('div', { class: 'dca' }, [name, el('div', { class: 'fader-row' }, [fader, out]), mute]);
    $('#dcas').append(root);
    p = { name, fader, out, mute };
    dcaEls.set(d.n, p);
  }
  p.name.textContent = `DCA ${d.n}${d.name ? ` · ${d.name}` : ''}`;
  if (!busy.has(`dca-${d.n}`)) {
    const db = d.faderDb === NEG_INF ? FADER_MIN : Math.max(FADER_MIN, d.faderDb);
    p.fader.value = String(db);
    p.out.textContent = fmtDb(db);
  }
  p.mute.textContent = d.on ? 'Mute' : 'Muted';
  p.mute.className = `btn btn-small ${d.on ? 'btn-ghost' : 'mute-on'}`;
}

// ---------- page ----------

function render(s) {
  const st = s.status;
  if (st.connected) setPill($('#conn'), 'ok', `Mixer: ${st.mixer?.name ?? 'connected'}`);
  else if (st.searching) setPill($('#conn'), 'warn', 'Looking for mixer…');
  else setPill($('#conn'), 'danger', 'Mixer offline');

  const g = s.clickGuard;
  if (!g.locked.length) setPill($('#lock'), 'warn', 'No click/guide channel found');
  else if (g.allSafe) setPill($('#lock'), 'ok', `Click & guide locked ✓ (${g.locked.map((l) => l.name).join(', ')})`);
  else setPill($('#lock'), 'danger', 'Click/guide reaching house — fixing');

  const inv = s.inventory;
  const c = inv.counts;
  $('#summary').textContent =
    `${c.inUse} in use · ${c.unused} unused${c.unusedOpen ? ` (${c.unusedOpen} still open)` : ''}` +
    (inv.tracks.present ? ` · Tracks ${inv.tracks.playing ? 'playing' : 'silent'}` : '');
  const issues = [];
  for (const r of inv.rows) {
    if (r.status === 'silent' && !r.locked && r.role !== 'track' && r.role !== 'walkin')
      issues.push(['warn', `⚠️ ${r.label} "${r.name}": named but no signal. Check battery, cable or receiver.`]);
    if (r.status === 'unlabeled-signal') issues.push(['warn', `❓ ${r.label}: signal on an unnamed channel. What is it? Set its role below.`]);
    if (r.role === 'unknown' && r.roleSource !== 'confirmed') issues.push(['info', `❔ ${r.label} "${r.name}": couldn't tell what this is from its name. Set its role below.`]);
  }
  if (!issues.length) issues.push(['ok', '✅ Nothing needs attention.']);
  $('#issues').replaceChildren(...issues.map(([k, t]) => el('li', { class: `lvl-${k}`, text: t })));

  if (s.walkin.length) {
    const fading = s.walkin.some((w) => w.fading);
    const on = s.walkin.some((w) => w.on);
    $('#walkinState').textContent = fading ? 'Fading…' : on ? 'Playing in the house.' : 'Off.';
  } else {
    $('#walkinState').textContent = 'No walk-in channel found. Name a channel "Walk-in" or set its role.';
  }

  $('#alerts').replaceChildren(
    ...(s.alerts.length
      ? s.alerts.map((a) => {
          const li = el('li', { class: `lvl-${a.level}` }, [
            el('span', { class: 'msg', text: a.message }),
            el('time', { text: new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) }),
          ]);
          return li;
        })
      : [el('li', { class: 'lvl-ok', text: 'No alerts.' })]),
  );

  for (const d of s.dcas) updateDca(d);
  for (const r of inv.rows) updateStrip(r, s.roles);
}

$('#muteUnused').addEventListener('click', () => send({ type: 'muteUnused' }));
$('#walkinOut').addEventListener('click', () => send({ type: 'walkin', action: 'out' }));
$('#walkinIn').addEventListener('click', () => send({ type: 'walkin', action: 'in' }));
$('#clearAlerts').addEventListener('click', () => send({ type: 'clearAlerts' }));

// Keep the iPad screen awake while the app is open.
async function keepAwake() {
  try {
    await navigator.wakeLock?.request('screen');
  } catch {
    /* not supported or not allowed yet */
  }
}
document.addEventListener('click', keepAwake, { once: true });
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && keepAwake());

connect();
