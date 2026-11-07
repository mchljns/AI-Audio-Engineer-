// One-tap effect setup: Mix Assistant sets the reverb and the delay itself, then asks a person to
// confirm in X Air that it landed as intended. Until confirmed it changes nothing for good: a "No"
// puts back exactly what was there before.
//
// The XR18's effects come from the X32 library. Algorithm numbers and parameter layouts below
// follow the X32 tables (type order HALL, AMBI, RPLT, ROOM, CHAM, PLAT, VREV, VRM, GATE, RVRS,
// DLY…; PLAT 12 parameters; DLY 2 + 3 + 7), which the XR18 is believed to share. That's exactly
// why each one is checked once (QA P12).
//
// Addresses: /fx/N/type (int), /fx/N/par/01..12 (float 0..1, or int for switches).

const lin = (min, max) => ({ toRaw: (v) => (v - min) / (max - min), fromRaw: (r) => min + (max - min) * r });
const log = (min, max) => ({ toRaw: (v) => Math.log(v / min) / Math.log(max / min), fromRaw: (r) => min * Math.exp(Math.log(max / min) * r) });
const pad2 = (n) => String(n).padStart(2, '0');
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;

export const fxTypeAddress = (fx) => `/fx/${fx}/type`;
export const fxParAddress = (fx, n) => `/fx/${fx}/par/${pad2(n)}`;

// The effects Mix Assistant knows how to run, with the parameters it sets.
export const PROFILES = {
  plate: {
    kind: 'reverb',
    label: 'Vocal plate',
    type: 5, // PLAT
    params: {
      preDelay: { n: 1, scale: lin(0, 200), unit: 'ms', label: 'Pre-delay', min: 20, max: 110, start: 60 },
      decay: { n: 2, scale: log(0.5, 10), unit: 's', label: 'Decay', min: 0.8, max: 3, start: 1.6 },
      loCut: { n: 7, scale: log(10, 500), unit: 'Hz', label: 'Low cut', min: 80, max: 500, start: 250 },
      hiCut: { n: 8, scale: log(200, 20000), unit: 'Hz', label: 'High cut', min: 3000, max: 12000, start: 6500 },
    },
  },
  delay: {
    kind: 'delay',
    label: 'Stereo delay',
    type: 10, // DLY
    params: {
      mix: { n: 1, scale: lin(0, 100), unit: '%', label: 'Mix', min: 100, max: 100, start: 100 },
      time: { n: 2, scale: log(1, 3000), unit: 'ms', label: 'Time', min: 30, max: 2000, start: 500 },
      loCut: { n: 7, scale: log(10, 500), unit: 'Hz', label: 'Low cut', min: 100, max: 500, start: 300 },
      hiCut: { n: 8, scale: log(200, 20000), unit: 'Hz', label: 'High cut', min: 2000, max: 10000, start: 5000 },
      feedL: { n: 10, scale: lin(1, 100), unit: '%', label: 'Feedback L', min: 1, max: 45, start: 20 },
      feedR: { n: 12, scale: lin(1, 100), unit: '%', label: 'Feedback R', min: 1, max: 45, start: 20 },
    },
  },
};
// If the delay's Time doesn't read 500 ms, the second try uses a linear Time scale.
export const ATTEMPTS = {
  reverb: [{ profile: 'plate' }],
  delay: [{ profile: 'delay' }, { profile: 'delay', time: lin(1, 3000) }],
};

export function fmt(p, v) {
  if (p.unit === 'Hz') return v >= 1000 ? `${r1(v / 1000)} kHz` : `${Math.round(v)} Hz`;
  if (p.unit === 's') return `${r1(v)} s`;
  return `${Math.round(v)} ${p.unit}`;
}

// What each reverb fix does, once the app runs the reverb.
export const REVERB_TWEAKS = {
  washy: { label: 'Washy: words blur together', changes: { decay: -0.2, preDelay: +8 } },
  muddy: { label: 'Muddy: thick low end', changes: { loCut: +50 } },
  splashy: { label: 'Splashy or hissy', changes: { hiCut: -800 } },
  cave: { label: 'Like a cave: too long', changes: { decay: -0.3 } },
  dry: { label: 'Too short: no space', changes: { decay: +0.2 } },
  dull: { label: 'Dark or dull', changes: { hiCut: +800 } },
};

export class FxDesk {
  constructor({ client }) {
    this.client = client;
    this.raw = new Map(); // fx -> { type, pars: { n: raw } }
    this.pending = new Map(); // kind -> { fx, attempt, before }
    this.onMessage = (msg) => {
      const m = msg.address?.match(/^\/fx\/([1-4])\/(type|par\/(\d\d))$/);
      if (!m || !msg.args?.length) return;
      const fx = Number(m[1]);
      const e = this.raw.get(fx) ?? { type: null, pars: {} };
      if (m[2] === 'type') e.type = Number(msg.args[0].value);
      else e.pars[Number(m[3])] = Number(msg.args[0].value);
      this.raw.set(fx, e);
    };
    client?.on?.('message', this.onMessage);
  }

  stop() {
    this.client?.off?.('message', this.onMessage);
  }

  async read(fx) {
    this.client.query(fxTypeAddress(fx));
    for (let n = 1; n <= 16; n++) this.client.query(fxParAddress(fx, n));
    for (let i = 0; i < 20 && Object.keys(this.raw.get(fx)?.pars ?? {}).length < 12; i++) await new Promise((r) => setTimeout(r, 50));
    const e = this.raw.get(fx);
    return e ? { type: e.type, pars: { ...e.pars } } : null;
  }

  #write(fx, type, pars) {
    if (type !== null && type !== undefined) this.client.setInt(fxTypeAddress(fx), type);
    for (const [n, v] of Object.entries(pars)) this.client.setFloat(fxParAddress(fx, Number(n)), v);
    const e = this.raw.get(fx) ?? { type: null, pars: {} };
    if (type !== null && type !== undefined) e.type = type;
    Object.assign(e.pars, pars);
    this.raw.set(fx, e);
  }

  scales(kind, attempt) {
    const p = PROFILES[ATTEMPTS[kind][attempt].profile];
    const out = {};
    for (const [k, def] of Object.entries(p.params)) out[k] = { ...def, scale: ATTEMPTS[kind][attempt][k] ?? def.scale };
    return out;
  }

  /** Try the next way of setting up this effect. Returns what X Air should now show, or null when out of tries. */
  async trySetup(kind, fx, values = {}) {
    const prev = this.pending.get(kind);
    const attempt = prev ? prev.attempt + 1 : 0;
    if (!ATTEMPTS[kind][attempt]) {
      await this.cancel(kind);
      return null;
    }
    const before = prev?.before ?? (await this.read(fx));
    const profile = PROFILES[ATTEMPTS[kind][attempt].profile];
    const scales = this.scales(kind, attempt);
    const pars = {};
    const shows = [];
    for (const [k, def] of Object.entries(scales)) {
      const v = values[k] ?? def.start;
      pars[def.n] = clamp(def.scale.toRaw(v), 0, 1);
      shows.push(`${def.label} ${fmt(def, v)}`);
    }
    this.#write(fx, profile.type, pars);
    this.pending.set(kind, { fx, attempt, before });
    return { label: profile.label, shows };
  }

  /** "No, put it back": restore exactly what the effect had before the setup started. */
  async cancel(kind) {
    const p = this.pending.get(kind);
    this.pending.delete(kind);
    if (p?.before) this.#write(p.fx, p.before.type, p.before.pars);
  }

  /** "Yes, that's what X Air shows": remember how to drive this effect. */
  confirm(kind) {
    const p = this.pending.get(kind);
    this.pending.delete(kind);
    return p ? { fx: p.fx, attempt: p.attempt } : null;
  }

  /** Current value of one parameter of a confirmed effect. */
  value(kind, conf, key) {
    const def = this.scales(kind, conf.attempt)[key];
    const raw = this.raw.get(conf.fx)?.pars?.[def.n];
    return raw === undefined ? def.start : def.scale.fromRaw(raw);
  }

  set(kind, conf, key, v) {
    const def = this.scales(kind, conf.attempt)[key];
    const val = clamp(v, def.min, def.max);
    this.#write(conf.fx, null, { [def.n]: clamp(def.scale.toRaw(val), 0, 1) });
    return val;
  }

  /** Apply a reverb fix. Returns a sentence saying what changed. */
  tweak(conf, id) {
    const t = REVERB_TWEAKS[id];
    if (!t) return null;
    this.history ??= [];
    const scales = this.scales('reverb', conf.attempt);
    const before = {};
    const said = [];
    for (const [k, d] of Object.entries(t.changes)) {
      const cur = this.value('reverb', conf, k);
      before[k] = cur;
      const now = this.set('reverb', conf, k, cur + d);
      said.push(Math.abs(now - cur) < 1e-6 ? `${scales[k].label} already at its limit (${fmt(scales[k], now)})` : `${scales[k].label} ${fmt(scales[k], now)}`);
    }
    this.history.push(before);
    return `${t.label.split(':')[0]}: ${said.join(', ')}`;
  }

  undoTweak(conf) {
    const before = this.history?.pop();
    if (!before) return false;
    for (const [k, v] of Object.entries(before)) this.set('reverb', conf, k, v);
    return true;
  }

  describe(kind, conf) {
    if (!conf) return null;
    const scales = this.scales(kind, conf.attempt);
    return Object.entries(scales)
      .filter(([k]) => k !== 'mix')
      .map(([k, d]) => `${d.label} ${fmt(d, this.value(kind, conf, k))}`)
      .join(' · ');
  }
}
