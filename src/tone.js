// Tone at soundcheck: low cut, 4-band EQ, compressor and gate on an input channel, in plain words.
//
// Mix Assistant reads the channel's current settings from the mixer first, so it adjusts what's
// there (including anything set in the X Air app) instead of overwriting it. Every fix is a small,
// bounded step with undo. A person's tone can be saved and loaded onto whatever channel they're on
// next week.
//
// XR18 addresses and scalings follow the community-documented X Air protocol (see QA.md, P9):
//   /ch/NN/preamp/hpon, hpf (20–400 Hz, log)
//   /ch/NN/eq/on, /ch/NN/eq/1..4/type (0 LCut 1 LShv 2 PEQ 3 VEQ 4 HShv 5 HCut), f (20–20k log),
//     g (−15..+15 lin), q (0.3..10 log, inverted)
//   /ch/NN/dyn/on, mode, det, env, thr (−60..0), ratio (index), knee (0..5), mgain (0..24),
//     attack (0..120 ms), release (5..4000 ms log), auto, mix (0..100)
//   /ch/NN/gate/on, mode (0 exp2 1 exp3 2 exp4 3 gate 4 duck), thr (−80..0), range (3..60),
//     attack (0..120), hold (0.02..2000 log), release (5..4000 log)
// EQ and compression act on the channel before its sends, so they also change the in-ear sound
// of that channel. Aux send levels are never touched.

const pad2 = (n) => String(n).padStart(2, '0');
const lin = (min, max) => ({ toRaw: (v) => (v - min) / (max - min), fromRaw: (r) => min + (max - min) * r });
const log = (min, max) => ({ toRaw: (v) => Math.log(v / min) / Math.log(max / min), fromRaw: (r) => min * Math.exp(Math.log(max / min) * r) });
const inv = (m) => ({ toRaw: (v) => 1 - m.toRaw(v), fromRaw: (r) => m.fromRaw(1 - r) });
const int = { toRaw: (v) => Math.round(v), fromRaw: (r) => Math.round(r) };
const bool = { toRaw: (v) => (v ? 1 : 0), fromRaw: (r) => !!r };

export const RATIOS = [1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100];
export const EQ_TYPES = ['Low cut', 'Low shelf', 'Bell', 'Vintage bell', 'High shelf', 'High cut'];

// [model key, address suffix, scale, OSC type]. 'headamp' is the input gain (its own address).
const PARAMS = [
  ['gainDb', 'headamp', lin(-12, 60), 'f'],
  ['hpOn', 'preamp/hpon', bool, 'i'],
  ['hpHz', 'preamp/hpf', log(20, 400), 'f'],
  ['eqOn', 'eq/on', bool, 'i'],
  ...[1, 2, 3, 4].flatMap((b) => [
    [`b${b}.type`, `eq/${b}/type`, int, 'i'],
    [`b${b}.hz`, `eq/${b}/f`, log(20, 20000), 'f'],
    [`b${b}.db`, `eq/${b}/g`, lin(-15, 15), 'f'],
    [`b${b}.q`, `eq/${b}/q`, inv(log(0.3, 10)), 'f'],
  ]),
  ['comp.on', 'dyn/on', bool, 'i'],
  ['comp.mode', 'dyn/mode', int, 'i'],
  ['comp.thr', 'dyn/thr', lin(-60, 0), 'f'],
  ['comp.ratio', 'dyn/ratio', int, 'i'],
  ['comp.knee', 'dyn/knee', lin(0, 5), 'f'],
  ['comp.mgain', 'dyn/mgain', lin(0, 24), 'f'],
  ['comp.attack', 'dyn/attack', lin(0, 120), 'f'],
  ['comp.release', 'dyn/release', log(5, 4000), 'f'],
  ['comp.auto', 'dyn/auto', bool, 'i'],
  // The compressor's key filter: what it listens to. Pops mode listens only below ~150 Hz.
  // Filter types follow the X32 list (0 LC6, 1 LC12, 2 HC6, 3 HC12, 4–8 band): QA P14.
  ['comp.keyOn', 'dyn/filter/on', bool, 'i'],
  ['comp.keyType', 'dyn/filter/type', int, 'i'],
  ['comp.keyHz', 'dyn/filter/f', log(20, 20000), 'f'],
  ['gate.on', 'gate/on', bool, 'i'],
  ['gate.mode', 'gate/mode', int, 'i'],
  ['gate.thr', 'gate/thr', lin(-80, 0), 'f'],
  ['gate.range', 'gate/range', lin(3, 60), 'f'],
  ['gate.attack', 'gate/attack', lin(0, 120), 'f'],
  ['gate.hold', 'gate/hold', log(0.02, 2000), 'f'],
  ['gate.release', 'gate/release', log(5, 4000), 'f'],
];

export const toneAddress = (ch, suffix) => (suffix === 'headamp' ? `/headamp/${pad2(ch)}/gain` : `/ch/${pad2(ch)}/${suffix}`);
/** Every address that makes up a channel's tone (for reading it from the mixer). */
export const tonePaths = (ch) => PARAMS.map(([, suffix]) => toneAddress(ch, suffix));
/** Only real input channels have this processing (not the aux return). */
export const toneChannelOk = (ch) => /^([1-9]|1[0-6])$/.test(String(ch));

const suffixOf = (address) => (/^\/headamp\//.test(address) ? 'headamp' : address.replace(/^\/ch\/\d\d\//, ''));
const get = (m, key) => key.split('.').reduce((o, k) => o?.[k], m);
const set = (m, key, v) => {
  const ks = key.split('.');
  const last = ks.pop();
  let o = m;
  for (const k of ks) o = o[k] ??= {};
  o[last] = v;
};

/** Raw mixer values { suffix: raw } → a model in real units. Missing values stay undefined. */
export function modelFromRaw(raw) {
  const m = { b1: {}, b2: {}, b3: {}, b4: {}, comp: {}, gate: {} };
  for (const [key, suffix, scale] of PARAMS) if (raw[suffix] !== undefined) set(m, key, scale.fromRaw(raw[suffix]));
  return m;
}

/** The OSC messages that turn `from` into `to` (only what changed). */
export function messagesFor(ch, to, from = null) {
  const out = [];
  for (const [key, suffix, scale, type] of PARAMS) {
    const v = get(to, key);
    if (v === undefined) continue;
    const r = Math.max(0, Math.min(type === 'f' ? 1 : 1e6, scale.toRaw(v)));
    const old = from ? get(from, key) : undefined;
    if (old !== undefined && Math.abs(scale.toRaw(old) - r) < 1e-4) continue;
    out.push({ address: toneAddress(ch, suffix), type, value: type === 'i' ? Math.round(r) : r });
  }
  return out;
}

const clone = (m) => JSON.parse(JSON.stringify(m));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const round = (v, n = 1) => Math.round(v * 10 ** n) / 10 ** n;

// ---------- the fix buttons ----------
// band: which of the 4 bands the fix uses (1 low, 2 low-mid, 3 high-mid, 4 high). step: dB per tap.
// limit: how far it may go in total. hp: low-cut steps instead of EQ.
const F = (label, hint, spec) => ({ label, hint, ...spec });
const VOCAL = {
  boomy: F('Boomy / pops', 'Low rumble, "p" pops, handling noise', { hp: +1 }),
  muddy: F('Muddy', 'Thick, unclear, cloudy', { band: 1, type: 2, hz: 300, q: 1.4, step: -2, limit: -9 }),
  thin: F('Thin', 'No body or warmth', { band: 1, type: 2, hz: 200, q: 1, step: +2, limit: 6, hp: -1 }),
  boxy: F('Boxy', 'Like singing into a cardboard box', { band: 2, type: 2, hz: 600, q: 1.4, step: -2, limit: -8 }),
  nasal: F('Nasal', 'Honky, "through the nose"', { band: 2, type: 2, hz: 1000, q: 1.6, step: -2, limit: -8 }),
  buried: F('Buried / unclear', "Words don't come through the band", { band: 3, type: 2, hz: 3500, q: 1, step: +2, limit: 6 }),
  harsh: F('Harsh', 'Piercing, tiring, edgy', { band: 3, type: 2, hz: 3000, q: 1.4, step: -2, limit: -8 }),
  sibilant: F("Sharp S's", 'Hissy "s", "t", "sh"', { band: 4, type: 2, hz: 7000, q: 2, step: -2, limit: -8 }),
  dull: F('Dull', 'Needs air and sparkle', { band: 4, type: 4, hz: 10000, q: 0.7, step: +2, limit: 5 }),
};
export const FIXES = {
  vocal: VOCAL,
  acoustic: {
    boomy: F('Boomy', 'Low boom from the body', { band: 1, type: 2, hz: 150, q: 1.2, step: -2, limit: -9 }),
    muddy: F('Muddy', 'Thick, unclear strums', { band: 1, type: 2, hz: 250, q: 1.4, step: -2, limit: -8 }),
    thin: F('Thin', 'No body', { band: 1, type: 2, hz: 200, q: 1, step: +2, limit: 5, hp: -1 }),
    quacky: F('Quacky', 'Plasticky pickup sound', { band: 2, type: 2, hz: 1200, q: 1.6, step: -2, limit: -8 }),
    buried: F('Buried', "Doesn't cut through", { band: 3, type: 2, hz: 3000, q: 1, step: +2, limit: 5 }),
    harsh: F('Harsh / string noise', 'Sharp, scratchy, pick noise', { band: 3, type: 2, hz: 3500, q: 1.4, step: -2, limit: -8 }),
    dull: F('Dull', 'Needs sparkle', { band: 4, type: 4, hz: 8000, q: 0.7, step: +2, limit: 5 }),
    rumble: F('Rumble / feedback hum', 'Low hum or ring from the body', { hp: +1 }),
  },
  keys: {
    rumble: F('Rumble', 'Low end fighting the bass', { hp: +1 }),
    muddy: F('Muddy', 'Thick, crowds the vocals', { band: 1, type: 2, hz: 250, q: 1.2, step: -2, limit: -8 }),
    boxy: F('Boxy', 'Honky middle', { band: 2, type: 2, hz: 600, q: 1.4, step: -2, limit: -8 }),
    harsh: F('Harsh', 'Piercing', { band: 3, type: 2, hz: 3000, q: 1.4, step: -2, limit: -8 }),
    vocalspace: F('Make room for vocals', 'Keys cover the singers', { band: 3, type: 2, hz: 2500, q: 0.9, step: -1.5, limit: -6 }),
    dull: F('Dull', 'Needs sparkle', { band: 4, type: 4, hz: 10000, q: 0.7, step: +2, limit: 5 }),
    thin: F('Thin', 'No body', { band: 1, type: 2, hz: 150, q: 1, step: +2, limit: 5, hp: -1 }),
  },
  electric: {
    rumble: F('Rumble', 'Low end fighting the bass', { hp: +1 }),
    muddy: F('Muddy', 'Woolly, unclear', { band: 1, type: 2, hz: 250, q: 1.4, step: -2, limit: -8 }),
    buried: F('Buried', "Doesn't cut through", { band: 2, type: 2, hz: 1000, q: 1, step: +2, limit: 5 }),
    harsh: F('Harsh', 'Piercing', { band: 3, type: 2, hz: 3000, q: 1.4, step: -2, limit: -8 }),
    fizzy: F('Fizzy', 'Buzzy top end', { band: 4, type: 2, hz: 6000, q: 1.2, step: -2, limit: -8 }),
    vocalspace: F('Make room for vocals', 'Guitar covers the singers', { band: 3, type: 2, hz: 2500, q: 0.9, step: -1.5, limit: -6 }),
  },
};
FIXES.other = FIXES.keys;
FIXES.bass = { rumble: FIXES.keys.rumble, muddy: FIXES.keys.muddy };
FIXES.drums = { rumble: FIXES.keys.rumble, muddy: FIXES.keys.muddy, harsh: FIXES.keys.harsh };

const HP_STEPS = [60, 80, 100, 120, 150, 180];
const HP_DEFAULT = { vocal: 100, acoustic: 80, keys: 40, electric: 80, bass: 30, drums: 40, other: 60 };

/** Apply one fix button to a model. Returns { model, note } (note says what changed, or why not). */
export function applyFix(model, instrument, fixId) {
  const fix = FIXES[instrument]?.[fixId] ?? FIXES.vocal[fixId];
  if (!fix) return { model, note: null };
  const m = clone(model);
  const notes = [];
  if (fix.hp) {
    const cur = m.hpOn ? m.hpHz : 20;
    let next;
    if (fix.hp > 0) next = !m.hpOn || cur < (HP_DEFAULT[instrument] ?? 80) - 2 ? Math.max(HP_DEFAULT[instrument] ?? 80, 80) : (HP_STEPS.find((h) => h > cur + 2) ?? HP_STEPS.at(-1));
    else next = [...HP_STEPS].reverse().find((h) => h < cur - 2) ?? 20;
    if (fix.hp < 0 && !fix.band && !m.hpOn) return { model, note: 'Low cut is already off.' };
    if (fix.hp > 0 || m.hpOn) {
      m.hpOn = next > 20;
      m.hpHz = Math.max(20, next);
      notes.push(m.hpOn ? `Low cut ${Math.round(m.hpHz)} Hz` : 'Low cut off');
    }
  }
  if (fix.band) {
    const b = m[`b${fix.band}`];
    m.eqOn = true;
    // Same kind of move on the same band and frequency: add to it. Otherwise the band is re-aimed.
    const same = b.type === fix.type && Math.abs(Math.log2((b.hz ?? fix.hz) / fix.hz)) < 0.15 && Math.sign(b.db ?? 0) !== -Math.sign(fix.step);
    const start = same ? (b.db ?? 0) : 0;
    const lim = fix.limit;
    const next = lim < 0 ? Math.max(lim, start + fix.step) : Math.min(lim, start + fix.step);
    if (same && next === start) return { model, note: `${fix.label}: already at the limit (${lim > 0 ? '+' : ''}${lim} dB).` };
    Object.assign(b, { type: fix.type, hz: fix.hz, q: fix.q, db: round(next) });
    notes.push(`${next > 0 ? '+' : ''}${round(next)} dB at ${fmtHz(fix.hz)}`);
  }
  return { model: m, note: `${fix.label}: ${notes.join(', ')}` };
}

// ---------- compression and gate ----------
export const COMP_PRESETS = {
  light: { label: 'Light', ratio: 2, squeeze: 3, attack: 15 },
  medium: { label: 'Medium', ratio: 3, squeeze: 5, attack: 10 },
  firm: { label: 'Firm', ratio: 4, squeeze: 8, attack: 6 },
};

/**
 * Compressor from a measured loud level: loud lines get about the preset's squeeze.
 * loudDb is the channel level during their loudest singing/playing.
 */
export function applyComp(model, preset, loudDb) {
  const m = clone(model);
  if (preset === 'off') {
    m.comp.on = false;
    return { model: m, note: 'Compression off' };
  }
  const p = COMP_PRESETS[preset];
  if (!p || !Number.isFinite(loudDb)) return { model, note: null };
  const ratioIndex = RATIOS.indexOf(p.ratio);
  // Gain reduction = (level − threshold) × (1 − 1/ratio)  →  threshold for the target squeeze.
  const thr = clamp(round(loudDb - p.squeeze / (1 - 1 / p.ratio)), -50, -5);
  Object.assign(m.comp, { on: true, mode: 0, thr, ratio: ratioIndex, knee: 2, mgain: round(p.squeeze / 2), attack: p.attack, release: 150, auto: true, keyOn: false });
  return { model: m, note: `Compression ${p.label.toLowerCase()}: ${p.ratio}:1, threshold ${thr} dB, about ${p.squeeze} dB off the loudest lines` };
}

/**
 * Input gain from a measured loud level: their loudest part should peak about −15 dB on the
 * channel meter (the −18 to −12 sweet spot). The compressor and gate thresholds move with it,
 * so they keep doing the same job. At most 12 dB per press, within the preamp's range.
 */
export const GAIN_TARGET_DB = -15;
export function applyGain(model, loudDb) {
  if (!Number.isFinite(loudDb) || !Number.isFinite(model.gainDb)) return { model, note: null };
  const m = clone(model);
  const want = clamp(GAIN_TARGET_DB - loudDb, -12, 12);
  const next = clamp(round(model.gainDb + want, 1), -12, 60);
  const moved = round(next - model.gainDb, 1);
  if (Math.abs(moved) < 1) return { model, note: `Gain is right already (loudest part about ${round(loudDb)} dB)` };
  m.gainDb = next;
  if (m.comp?.thr !== undefined) m.comp.thr = clamp(round(m.comp.thr + moved), -60, 0);
  if (m.gate?.thr !== undefined) m.gate.thr = clamp(round(m.gate.thr + moved), -80, 0);
  const atEdge = next === 60 || next === -12;
  return {
    model: m,
    note: `Gain ${moved > 0 ? 'up' : 'down'} ${Math.abs(moved)} dB to ${next > 0 ? '+' : ''}${next} dB${atEdge ? ' (the end of the range: check the wireless receiver or DI output level)' : ''}`,
  };
}

/**
 * Pop guard: the compressor listens only to the lows (below about 150 Hz), reacts in about a
 * millisecond and lets go quickly, so a "p" or "b" burst ducks the channel for an instant while
 * normal singing (which has little energy down there) passes untouched. It replaces the
 * person's normal compression: a channel has one compressor.
 * loudDb is their loudest normal singing; nudge: −3 = catch more, +3 = catch less.
 */
export function applyPops(model, loudDb, nudge = 0) {
  const m = clone(model);
  if (loudDb === 'off') {
    m.comp.on = false;
    m.comp.keyOn = false;
    return { model: m, note: 'Pop guard off' };
  }
  let thr;
  if (nudge && m.comp?.keyOn && Number.isFinite(m.comp.thr)) thr = clamp(round(m.comp.thr + nudge), -50, -5);
  else if (Number.isFinite(loudDb)) thr = clamp(round(loudDb - 6), -50, -5);
  else return { model, note: null };
  Object.assign(m.comp, { on: true, mode: 0, thr, ratio: RATIOS.indexOf(4), knee: 0, mgain: 0, attack: 1, release: 80, auto: false, keyOn: true, keyType: 3, keyHz: 150 });
  return { model: m, note: nudge ? `Pop guard ${nudge < 0 ? 'catches more' : 'catches less'}: threshold ${thr} dB` : `Pop guard on: the compressor listens below 150 Hz and ducks "p" and "b" bursts (threshold ${thr} dB)` };
}

/** Gentle gate for hiss between lines, from the measured quiet level (pack hiss, room). */
export function applyGate(model, on, floorDb) {
  const m = clone(model);
  if (!on) {
    m.gate.on = false;
    return { model: m, note: 'Gate off' };
  }
  if (!Number.isFinite(floorDb)) return { model, note: null };
  const thr = clamp(round(floorDb + 10), -75, -30);
  // A gentle 1:2 expander (mode 0 = EXP2), not a hard gate: below the threshold the hiss fades
  // down smoothly (10 dB of hiss below it comes down another 10 dB), with a 300 ms hold so word
  // endings and breaths aren't chopped.
  Object.assign(m.gate, { on: true, mode: 0, thr, range: 30, attack: 5, hold: 300, release: 300 });
  return { model: m, note: `Hiss expander on: below ${thr} dB the hiss fades down smoothly between lines` };
}

/** A clean starting point: EQ flat, a sensible low cut, no compressor or gate. */
export function freshModel(instrument) {
  const flat = (b, hz) => ({ type: 2, hz, q: 1.4, db: 0, b });
  const hp = HP_DEFAULT[instrument] ?? 60;
  return {
    hpOn: hp > 40,
    hpHz: Math.max(20, hp),
    eqOn: true,
    b1: { ...flat(1, 250) },
    b2: { ...flat(2, 800) },
    b3: { ...flat(3, 3000) },
    b4: { ...flat(4, 8000) },
    comp: { on: false },
    gate: { on: false },
  };
}

export function fmtHz(hz) {
  return hz >= 1000 ? `${round(hz / 1000, hz >= 10000 ? 0 : 1)} kHz` : `${Math.round(hz)} Hz`;
}

/** A plain-English one-liner of what's on the channel. */
export function describeTone(m) {
  if (!m) return '';
  const parts = [];
  if (Number.isFinite(m.gainDb)) parts.push(`Gain ${m.gainDb > 0 ? '+' : ''}${round(m.gainDb)} dB`);
  parts.push(m.hpOn ? `Low cut ${Math.round(m.hpHz)} Hz` : 'Low cut off');
  if (m.eqOn !== false) {
    for (const k of ['b1', 'b2', 'b3', 'b4']) {
      const b = m[k];
      if (!b || b.type === undefined || Math.abs(b.db ?? 0) < 0.5 || b.type === 0 || b.type === 5) continue;
      parts.push(`${b.db > 0 ? '+' : ''}${round(b.db)} dB ${b.type === 1 ? 'below' : b.type === 4 ? 'above' : 'at'} ${fmtHz(b.hz)}`);
    }
  } else parts.push('EQ off');
  if (m.comp?.on && m.comp.keyOn && m.comp.keyType === 3) parts.push(`Pop guard from ${round(m.comp.thr)} dB`);
  else if (m.comp?.on) parts.push(`Compression ${RATIOS[m.comp.ratio] ?? '?'}:1 from ${round(m.comp.thr)} dB`);
  else parts.push('No compression');
  if (m.gate?.on) parts.push(`${m.gate.mode === 0 ? 'Hiss expander' : 'Gate'} below ${round(m.gate.thr)} dB`);
  return parts.join(' · ');
}

/** Only the parts of a model that make up "this person's tone" (for saving). */
export function toneToSave(m) {
  const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));
  return {
    gainDb: m.gainDb,
    hpOn: m.hpOn,
    hpHz: m.hpHz,
    eqOn: m.eqOn,
    b1: pick(m.b1, ['type', 'hz', 'db', 'q']),
    b2: pick(m.b2, ['type', 'hz', 'db', 'q']),
    b3: pick(m.b3, ['type', 'hz', 'db', 'q']),
    b4: pick(m.b4, ['type', 'hz', 'db', 'q']),
    comp: pick(m.comp, ['on', 'mode', 'thr', 'ratio', 'knee', 'mgain', 'attack', 'release', 'auto', 'keyOn', 'keyType', 'keyHz']),
    gate: pick(m.gate, ['on', 'mode', 'thr', 'range', 'attack', 'hold', 'release']),
  };
}

/** Reads and writes channel tone over OSC, keeping a copy of what's on each channel. */
export class ToneDesk {
  constructor({ client }) {
    this.client = client;
    this.raw = new Map(); // ch -> { suffix: raw }
    this.history = new Map(); // ch -> [model, ...] for undo
    this.notes = new Map(); // ch -> last change, in words
    this.onMessage = (msg) => this.#onMessage(msg);
    client?.on?.('message', this.onMessage);
  }

  stop() {
    this.client?.off?.('message', this.onMessage);
  }

  #onMessage(msg) {
    if (!msg.args?.length) return;
    const g = msg.address?.match(/^\/headamp\/(\d\d)\/gain$/);
    const m = g ? null : msg.address?.match(/^\/ch\/(\d\d)\/(preamp\/hp(?:on|f)|eq\/(?:on|[1-4]\/(?:type|f|g|q))|dyn\/\w+|gate\/\w+)$/);
    if (!g && !m) return;
    const ch = String(Number((g ?? m)[1]));
    if (!this.raw.has(ch)) this.raw.set(ch, {});
    this.raw.get(ch)[g ? 'headamp' : m[2]] = Number(msg.args[0].value);
  }

  /** Ask the mixer for a channel's tone; resolves when it has answered (or after a short wait). */
  async read(ch) {
    if (!toneChannelOk(ch) || !this.client) return null;
    const want = PARAMS.length;
    for (const p of tonePaths(ch)) this.client.query(p);
    for (let i = 0; i < 20 && Object.keys(this.raw.get(ch) ?? {}).length < want; i++) await new Promise((r) => setTimeout(r, 50));
    return this.model(ch);
  }

  model(ch) {
    const raw = this.raw.get(String(ch));
    return raw ? modelFromRaw(raw) : null;
  }

  #send(ch, to, from) {
    for (const msg of messagesFor(ch, to, from)) {
      if (msg.type === 'i') this.client.setInt(msg.address, msg.value);
      else this.client.setFloat(msg.address, msg.value);
      if (!this.raw.has(ch)) this.raw.set(ch, {});
      this.raw.get(ch)[suffixOf(msg.address)] = msg.value;
    }
  }

  /**
   * Before / After: hear the last change without losing it. 'before' puts the previous settings on
   * the mixer, 'after' puts the change back. Undo history is untouched.
   */
  ab(chs, which) {
    for (const ch of chs) {
      const pair = this.lastAB?.get(ch);
      if (!pair) continue;
      this.#send(ch, which === 'before' ? pair.before : pair.after, this.model(ch));
      pair.hearing = which;
    }
  }

  /** Send a new model to one or more channels (a stereo pair gets the same). Undo-able. */
  write(chs, next, note) {
    this.lastAB ??= new Map();
    for (const ch of chs) {
      if (!toneChannelOk(ch)) continue;
      // If someone was listening to "before", the change they're making builds on the "after".
      if (this.lastAB.get(ch)?.hearing === 'before') this.ab([ch], 'after');
      const cur = this.model(ch);
      if (cur) this.lastAB.set(ch, { before: cur, after: { ...cur, ...next }, hearing: 'after' });
      if (cur) {
        const h = this.history.get(ch) ?? [];
        h.push(cur);
        this.history.set(ch, h.slice(-20));
      }
      for (const msg of messagesFor(ch, next, cur)) {
        if (msg.type === 'i') this.client.setInt(msg.address, msg.value);
        else this.client.setFloat(msg.address, msg.value);
        const suffix = suffixOf(msg.address);
        if (!this.raw.has(ch)) this.raw.set(ch, {});
        this.raw.get(ch)[suffix] = msg.value;
      }
      if (note) this.notes.set(ch, note);
    }
  }

  undo(chs) {
    for (const ch of chs) if (this.lastAB?.get(ch)?.hearing === 'before') this.ab([ch], 'after');
    const prev = this.history.get(chs[0])?.pop();
    if (!prev) return false;
    for (const ch of chs) this.lastAB?.delete(ch);
    for (const ch of chs.slice(1)) this.history.get(ch)?.pop();
    const cur = this.model(chs[0]);
    for (const ch of chs) {
      for (const msg of messagesFor(ch, prev, cur)) {
        if (msg.type === 'i') this.client.setInt(msg.address, msg.value);
        else this.client.setFloat(msg.address, msg.value);
        this.raw.get(ch)[suffixOf(msg.address)] = msg.value;
      }
      this.notes.set(ch, 'Undone');
    }
    return true;
  }

  status(ch) {
    const m = this.model(ch);
    const ab = this.lastAB?.get(String(ch));
    return m ? { model: m, summary: describeTone(m), canUndo: (this.history.get(String(ch))?.length ?? 0) > 0, note: this.notes.get(String(ch)) ?? null, ab: ab ? ab.hearing : null } : null;
  }
}
