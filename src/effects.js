// Effects: reverb and a light delay, handled so nobody has to think about them during a service.
//
//   1. Speech stays dry. The pastor's mic never feeds an effect (always), and announcement mics
//      don't either unless that's switched off. A send that appears is set back to zero, once,
//      with a note.
//   2. Effects follow the service. The reverb and delay RETURNS (their level in the room) come
//      down a few dB while someone talks between songs or over music, and further for the sermon
//      and pre/post-service music; back to where a person set them for worship. Only the return
//      faders move: the returns' sends to the in-ear mixes are never touched.
//   3. Light delay per song. On songs marked "light delay", the lead singer's send to the delay
//      comes up to their amount (from their saved tone, or a light default) during worship, and
//      every singer's delay send is zero the rest of the time.
//
// A person always wins: moving a return fader sets its new level. Like the auto-mix, it saves
// what it changed so a restart puts the returns back.
//
// XR18 addresses (community-documented, confirm on the mixer: QA P10):
//   /rtn/1..4/mix/fader   FX return level      /ch/NN/mix/07..10/level  channel → FX1..4 send

import fs from 'node:fs';
import path from 'node:path';
import { dbToFloat, floatToDb } from './xair/faderLaw.js';
import { paths, STRIP_IDS, FX_SEND_FIRST } from './xair/addresses.js';
import { resolveRole } from './inventory.js';

export const fxReturnFader = (n) => `/rtn/${n}/mix/fader`;
export const fxSendBus = (fx) => FX_SEND_FIRST + fx - 1; // FX1 → mix send 07
const HUMAN_TOLERANCE = 0.02;

export const EFFECT_DEFAULTS = {
  reverbFx: 1,
  delayFx: 2, // null = no delay set up
  follow: true, // effects follow the service
  speechDry: true, // announcement mics dry too (the pastor is always dry)
  talkDb: 6, // returns down this much while someone talks between songs / over music
  quietDb: 15, // and this much for the sermon and pre/post-service music
  delayNote: 'dotted8', // delay time: dotted eighth (the usual worship delay), quarter or eighth
  delayTimeAuto: false, // the app sets the delay's time itself: only after the test below says yes
  delayTimeMap: null, // how the XR18 scales the delay time ('log' or 'lin'), found by the test
};

// The delay's Time is parameter 1 of the XR18's delay effects. Its scaling isn't documented for
// the XR18, so the app tests it once: it sets 500 ms one way and asks whether X Air shows 500 ms.
export const delayTimeAddress = (fx) => `/fx/${fx}/par/01`;
const MAPS = {
  log: (ms) => Math.log(ms / 1) / Math.log(3000 / 1),
  lin: (ms) => (ms - 1) / (3000 - 1),
};
export const DELAY_NOTES = { dotted8: { label: 'Dotted 1/8', factor: 0.75 }, quarter: { label: '1/4', factor: 1 }, eighth: { label: '1/8', factor: 0.5 } };
export function delayMsFor(bpm, note = 'dotted8') {
  const b = Number(bpm);
  if (!Number.isFinite(b) || b < 40 || b > 220) return null;
  return Math.round(Math.round(60000 / b) * (DELAY_NOTES[note]?.factor ?? 0.75));
}

// Reverb send amounts per person (dB on the channel's send to the reverb). Delay amounts likewise.
export const VERB_LEVELS = { dry: null, little: -18, normal: -12, more: -7 };
export const DELAY_LEVELS = { off: null, light: -16, more: -11 };
export const DEFAULT_DELAY_DB = -16;

/** Delay times for a tempo: a quarter note, and a dotted eighth (the common "worship" delay). */
export function delayTimes(bpm) {
  const b = Number(bpm);
  if (!Number.isFinite(b) || b < 40 || b > 220) return null;
  const quarter = Math.round(60000 / b);
  return { bpm: Math.round(b), quarter, dottedEighth: Math.round(quarter * 0.75) };
}

export class Effects {
  constructor({ state, client, roleStore, settings = {}, stateFile = null, onAlert = () => {} }) {
    this.state = state;
    this.client = client;
    this.roleStore = roleStore;
    this.stateFile = stateFile;
    this.onAlert = onAlert;
    this.settings = { ...EFFECT_DEFAULTS, ...settings };
    this.returns = new Map(); // fx number -> { home, offsetDb, targetDb, lastSent, known }
    this.song = { delay: false, lead: [], amounts: {}, bpm: null, title: null };
    this.mode = 'idle';
    this.dried = new Set(); // channels we've already told the person about
    this.reason = null;
    this.onMessage = (msg) => this.#onMessage(msg);
    client?.on?.('message', this.onMessage);
  }

  start() {
    for (let n = 1; n <= 4; n++) this.client?.query?.(fxReturnFader(n));
    this.started = Date.now();
  }

  stop() {
    this.client?.off?.('message', this.onMessage);
    this.releaseAll();
  }

  update(partial = {}) {
    for (const k of ['follow', 'speechDry']) if (typeof partial[k] === 'boolean') this.settings[k] = partial[k];
    if (DELAY_NOTES[partial.delayNote]) this.settings.delayNote = partial.delayNote;
    if (partial.delayTimeAuto === false) this.settings.delayTimeAuto = false;
    for (const k of ['reverbFx', 'delayFx']) {
      if (partial[k] === null || partial[k] === 0) this.settings[k] = null;
      else if ([1, 2, 3, 4].includes(Number(partial[k]))) this.settings[k] = Number(partial[k]);
    }
    if (this.settings.reverbFx && this.settings.reverbFx === this.settings.delayFx) this.settings.delayFx = null;
    if (!this.settings.follow) this.releaseAll();
    return this.settings;
  }

  /** The current song's delay plan, from the set. */
  setSong({ delay = false, lead = [], amounts = {}, bpm = null, title = null } = {}) {
    this.song = { delay: !!delay, lead: lead.map(String), amounts, bpm, title };
  }

  /** The tempo heard right now ({ bpm, source } or null). */
  setLive(live) {
    this.live = live;
  }

  /** The tempo the delay should follow: what's heard live, else the song's known tempo. */
  tempo() {
    return this.live?.bpm ?? this.song.bpm ?? null;
  }

  // ---------- delay time: tested once, then set automatically ----------

  /** Set the delay to 500 ms using one scaling, so a person can check X Air shows 500 ms. */
  testDelayTime() {
    const fx = this.settings.delayFx;
    if (!fx) return null;
    const order = ['log', 'lin'];
    const next = order[(order.indexOf(this.testing) + 1) % order.length] ?? 'log';
    this.testing = this.testing === undefined || this.testing === null ? 'log' : next;
    this.client.setFloat(delayTimeAddress(fx), MAPS[this.testing](500));
    return this.testing;
  }

  /** The person's answer: X Air showed 500 ms (turn on automatic delay time) or it didn't. */
  confirmDelayTime(ok) {
    if (ok && this.testing) {
      this.settings.delayTimeAuto = true;
      this.settings.delayTimeMap = this.testing;
      this.testing = null;
      this.lastDelayMs = null;
      return true;
    }
    return false;
  }

  #setDelayTime() {
    const fx = this.settings.delayFx;
    if (!fx || !this.settings.delayTimeAuto || !MAPS[this.settings.delayTimeMap] || !this.song.delay) return;
    const ms = delayMsFor(this.tempo(), this.settings.delayNote);
    if (!ms || ms < 30 || ms > 2000) return;
    // Only a real change (over 2%), so the delay doesn't wobble while the tempo estimate settles.
    if (this.lastDelayMs && Math.abs(ms - this.lastDelayMs) / this.lastDelayMs < 0.02) return;
    this.lastDelayMs = ms;
    this.client.setFloat(delayTimeAddress(fx), MAPS[this.settings.delayTimeMap](ms));
  }

  /** A person nudged the reverb (or delay) level in the room: change where it sits for worship. */
  nudgeReturn(fx, db) {
    const r = this.returns.get(fx);
    if (!r?.known || !(r.home > 0)) return false;
    r.home = dbToFloat(Math.max(-30, Math.min(6, floatToDb(r.home) + db)));
    this.#send(fx, dbToFloat(floatToDb(r.home) + r.offsetDb));
    this.#save();
    return floatToDb(r.home);
  }

  returnDb(fx) {
    const r = this.returns.get(fx);
    return r?.known && r.home > 0 ? Math.round(floatToDb(r.home) * 10) / 10 : null;
  }

  #onMessage(msg) {
    const m = msg.address?.match(/^\/rtn\/([1-4])\/mix\/fader$/);
    if (!m || !msg.args?.length) return;
    const n = Number(m[1]);
    const v = Number(msg.args[0].value);
    let r = this.returns.get(n);
    if (!r) {
      r = { home: v, offsetDb: 0, targetDb: 0, lastSent: v, known: true };
      this.returns.set(n, r);
      this.#restoreOne(n, r);
      return;
    }
    if (Math.abs(v - r.lastSent) > HUMAN_TOLERANCE) {
      // Someone moved it: that's its new level (with our current cut taken back out).
      r.home = v <= 0 ? 0 : dbToFloat(Math.min(10, floatToDb(v) - r.offsetDb));
      r.lastSent = v;
      this.#save();
    }
  }

  /** Call on every meter update, after the auto-mix has decided the mode. */
  tick({ mode, activity = {} }) {
    this.mode = mode;
    this.#keepSpeechDry();
    this.#manageDelaySends(mode);
    this.#setDelayTime();

    // Effects follow the service.
    let target = 0;
    this.reason = null;
    if (this.settings.follow) {
      if (mode === 'speaking' || mode === 'walkin') {
        target = -this.settings.quietDb;
        this.reason = mode === 'speaking' ? 'for the talk' : 'during pre/post-service music';
      } else if (mode === 'talkover' || (mode === 'worship' && activity.vocalTalking)) {
        target = -this.settings.talkDb;
        this.reason = 'while someone talks';
      }
    }
    for (const fx of [this.settings.reverbFx, this.settings.delayFx]) {
      if (!fx) continue;
      const r = this.returns.get(fx);
      if (!r?.known || !(r.home > 0)) continue;
      r.targetDb = target;
      const up = target > r.offsetDb;
      let next = r.offsetDb + (target - r.offsetDb) * (up ? 0.08 : 0.2); // down in ~0.5 s, back up gently
      if (Math.abs(target - next) < 0.3) next = target;
      next = Math.min(0, next);
      if (next === r.offsetDb) continue;
      r.offsetDb = next;
      const value = dbToFloat(floatToDb(r.home) + next);
      if (Math.abs(floatToDb(value) - floatToDb(r.lastSent)) >= 0.25 || next === target) this.#send(fx, value);
    }
  }

  #keepSpeechDry() {
    for (const id of STRIP_IDS) {
      const s = this.state.strips[id];
      if (!s?.synced) continue;
      const { role } = resolveRole(s, this.roleStore);
      if (role !== 'pastor' && !(role === 'speech' && this.settings.speechDry)) continue;
      for (let fx = 1; fx <= 4; fx++) {
        const bus = fxSendBus(fx);
        if ((s.sends?.[bus] ?? 0) > 0) {
          s.sends[bus] = 0;
          this.client.setFloat(paths.send(id, bus), 0);
          const key = `${id}:${fx}`;
          if (!this.dried.has(key)) {
            this.dried.add(key);
            this.onAlert({ level: 'info', source: 'effects', message: `Kept ${s.name || `Ch ${id}`} dry: turned off its send to FX${fx}. ${role === 'pastor' ? 'No reverb or delay on the pastor.' : 'Speech is clearer without effects (switch this off under Effects if you want it).'}` });
          }
        }
      }
    }
  }

  #manageDelaySends(mode) {
    const fx = this.settings.delayFx;
    if (!fx) return;
    const bus = fxSendBus(fx);
    const on = mode === 'worship' && this.song.delay;
    for (const id of STRIP_IDS) {
      const s = this.state.strips[id];
      if (!s?.synced || resolveRole(s, this.roleStore).role !== 'vocal') continue;
      const db = on && this.song.lead.includes(id) ? (this.song.amounts[id] ?? DEFAULT_DELAY_DB) : null;
      const want = db === null ? 0 : dbToFloat(db);
      if (Math.abs((s.sends?.[bus] ?? 0) - want) > 0.005) {
        s.sends[bus] = want;
        this.client.setFloat(paths.send(id, bus), want);
      }
    }
  }

  #send(fx, value) {
    const r = this.returns.get(fx);
    if (r) r.lastSent = value;
    this.client.setFloat(fxReturnFader(fx), value);
    this.#save();
  }

  releaseAll() {
    for (const [fx, r] of this.returns) {
      if (Math.abs(r.offsetDb) > 0.05 && r.home > 0) this.#send(fx, r.home);
      r.offsetDb = 0;
      r.targetDb = 0;
    }
  }

  #save() {
    if (!this.stateFile) return;
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(Object.fromEntries([...this.returns].map(([n, r]) => [n, { home: r.home, offsetDb: r.offsetDb }]))));
    } catch {
      /* best effort */
    }
  }

  /** After a restart: if a return is still where we left it, put it back to where the person set it. */
  #restoreOne(n, r) {
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))[n];
    } catch {
      return;
    }
    if (!saved || !(saved.home > 0) || Math.abs(saved.offsetDb) < 0.05) return;
    const leftAt = dbToFloat(floatToDb(saved.home) + saved.offsetDb);
    if (Math.abs(r.lastSent - leftAt) <= HUMAN_TOLERANCE) {
      r.home = saved.home;
      this.#send(n, saved.home);
    }
  }

  describe(names = {}) {
    const out = [];
    const rv = this.returns.get(this.settings.reverbFx);
    if (rv && rv.offsetDb < -1 && this.reason) out.push(`Reverb ${Math.round(rv.offsetDb)} dB ${this.reason}`);
    if (this.mode === 'worship' && this.song.delay && this.settings.delayFx) {
      const who = this.song.lead.map((id) => names[id] || `Ch ${id}`);
      const bpm = this.tempo();
      const ms = this.settings.delayTimeAuto && this.lastDelayMs ? this.lastDelayMs : delayMsFor(bpm, this.settings.delayNote);
      const src = this.live ? `, live from ${this.live.label ?? 'the music'}` : '';
      out.push(who.length ? `Light delay on ${[...new Set(who)].join(', ')}${ms ? ` (${ms} ms at ${Math.round(bpm)} BPM${src})` : ''}` : 'Light delay song: pick a lead singer for it to go on');
    }
    return out;
  }

  status() {
    return {
      settings: this.settings,
      reverbDb: this.returnDb(this.settings.reverbFx),
      delayDb: this.settings.delayFx ? this.returnDb(this.settings.delayFx) : null,
      song: { delay: this.song.delay, bpm: this.song.bpm, times: delayTimes(this.song.bpm) },
      live: this.live ?? null,
      delayMs: delayMsFor(this.tempo(), this.settings.delayNote),
      delaySetMs: this.settings.delayTimeAuto ? (this.lastDelayMs ?? null) : null,
      testing: this.testing ?? null,
    };
  }
}
