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
  delayNote: 'auto', // auto by tempo (1/16 on fast songs, dotted 1/8 on slow), or a fixed note
  // Effects Mix Assistant runs itself, after a person confirmed the one-tap setup in X Air:
  // { reverb: { fx, attempt } | null, delay: { fx, attempt } | null }
  fxConf: { reverb: null, delay: null },
  verbOffsets: { decay: 0, preDelay: 0 }, // a person's reverb fixes, kept on top of each song's timing
};

/**
 * Reverb timed to the song: decay about a half note (1.2–2 s), lead pre-delay about a 1/32 note
 * (40–80 ms), so the tail clears before the next phrase and each word lands dry first.
 */
export function reverbTiming(bpm) {
  const b = Number(bpm);
  if (!Number.isFinite(b) || b < 40 || b > 220) return { decay: 1.6, preDelay: 60 };
  const beat = 60000 / b;
  return { decay: Math.round(Math.max(1.2, Math.min(2.0, (2 * beat) / 1000)) * 10) / 10, preDelay: Math.round(Math.max(40, Math.min(80, beat / 8))) };
}

export const DELAY_NOTES = {
  auto: { label: 'Auto by tempo' },
  dotted8: { label: 'Dotted 1/8', factor: 0.75, feedback: 22 },
  quarter: { label: '1/4', factor: 1, feedback: 22 },
  eighth: { label: '1/8', factor: 0.5, feedback: 18 },
  sixteenth: { label: '1/16', factor: 0.25, feedback: 10 },
};
// Auto: fast songs get a short 1/16 "thickening" delay with little feedback; slower songs get a
// dotted-1/8 throw (the usual worship delay).
export const AUTO_FAST_BPM = 100;
export function delayNoteFor(bpm, note = 'auto') {
  if (note !== 'auto') return DELAY_NOTES[note] ? note : 'dotted8';
  return Number(bpm) >= AUTO_FAST_BPM ? 'sixteenth' : 'dotted8';
}
export function delayMsFor(bpm, note = 'auto') {
  const b = Number(bpm);
  if (!Number.isFinite(b) || b < 40 || b > 220) return null;
  return Math.round(Math.round(60000 / b) * DELAY_NOTES[delayNoteFor(b, note)].factor);
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
    this.settings = { ...EFFECT_DEFAULTS, ...settings, fxConf: { ...EFFECT_DEFAULTS.fxConf, ...(settings.fxConf ?? {}) } };
    // Earlier versions saved the old default (dotted 1/8) without anyone choosing it.
    if (!this.settings.delayNoteChosen) this.settings.delayNote = 'auto';
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
    if (DELAY_NOTES[partial.delayNote]) {
      this.settings.delayNote = partial.delayNote;
      this.settings.delayNoteChosen = true;
    }
    if (partial.forget === 'reverb' || partial.forget === 'delay') this.settings.fxConf = { ...this.settings.fxConf, [partial.forget]: null };
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

  /** A confirmed effect (the app runs it), or null. */
  conf(kind) {
    const c = this.settings.fxConf?.[kind];
    const fx = kind === 'reverb' ? this.settings.reverbFx : this.settings.delayFx;
    return c && c.fx === fx ? c : null;
  }

  #timeReverb() {
    const conf = this.conf('reverb');
    if (!conf || !this.desk) return;
    const base = reverbTiming(this.tempo());
    const off = this.settings.verbOffsets ?? { decay: 0, preDelay: 0 };
    const want = { decay: Math.round((base.decay + off.decay) * 10) / 10, preDelay: Math.round(base.preDelay + off.preDelay) };
    const last = this.lastVerb ?? {};
    // Only real changes: a new song, or a tempo change big enough to matter.
    if (Math.abs((last.decay ?? -9) - want.decay) < 0.1 && Math.abs((last.preDelay ?? -99) - want.preDelay) < 3) return;
    this.lastVerb = { decay: this.desk.set('reverb', conf, 'decay', want.decay), preDelay: this.desk.set('reverb', conf, 'preDelay', want.preDelay) };
  }

  /** After a person's reverb fix: keep what they did as an adjustment on top of song timing. */
  keepVerbFix() {
    const conf = this.conf('reverb');
    if (!conf || !this.desk) return;
    const base = reverbTiming(this.tempo());
    this.settings.verbOffsets = {
      decay: Math.round((this.desk.value('reverb', conf, 'decay') - base.decay) * 10) / 10,
      preDelay: Math.round(this.desk.value('reverb', conf, 'preDelay') - base.preDelay),
    };
    this.lastVerb = { decay: this.desk.value('reverb', conf, 'decay'), preDelay: this.desk.value('reverb', conf, 'preDelay') };
  }

  #setDelayTime() {
    const conf = this.conf('delay');
    if (!conf || !this.desk || !this.song.delay) return;
    const ms = delayMsFor(this.tempo(), this.settings.delayNote);
    if (!ms || ms < 30 || ms > 2000) return;
    // Only a real change (over 2%), so the delay doesn't wobble while the tempo estimate settles.
    if (this.lastDelayMs && Math.abs(ms - this.lastDelayMs) / this.lastDelayMs < 0.02) return;
    this.lastDelayMs = ms;
    this.desk.set('delay', conf, 'time', ms);
    // Feedback to suit the note: a short thickening delay barely repeats; a throw repeats 2–3 times.
    const fb = DELAY_NOTES[delayNoteFor(this.tempo(), this.settings.delayNote)].feedback;
    if (fb !== this.lastFeedback) {
      this.lastFeedback = fb;
      this.desk.set('delay', conf, 'feedL', fb);
      this.desk.set('delay', conf, 'feedR', fb);
    }
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
  tick({ mode, activity = {}, talkers = [] }) {
    this.mode = mode;
    this.#keepSpeechDry();
    this.#manageDelaySends(activity.vocalTalking ? 'talking' : mode);
    this.#dryTalkingSingers(mode, activity, talkers);
    this.#setDelayTime();
    this.#timeReverb();

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

  /**
   * A singer who talks (between songs, praying, over the pad) has their reverb send taken to zero
   * at once, and put back when the singing starts again. Their in-ear reverb of their own voice
   * goes dry while they talk, which is what you want for speech anyway.
   */
  #dryTalkingSingers(mode, activity, talkers) {
    this.driedSingers ??= new Map(); // channel -> reverb send level to put back
    const fx = this.settings.reverbFx;
    if (!fx) return;
    const bus = fxSendBus(fx);
    const talking = mode === 'talkover' || mode === 'speaking' || activity.vocalTalking;
    if (talking) {
      for (const id of talkers) {
        const s = this.state.strips[id];
        if (!s || this.driedSingers.has(id) || resolveRole(s, this.roleStore).role !== 'vocal') continue;
        const was = s.sends?.[bus] ?? 0;
        if (!(was > 0)) continue;
        this.driedSingers.set(id, was);
        s.sends[bus] = 0;
        this.client.setFloat(paths.send(id, bus), 0);
      }
    } else if (mode === 'worship' && this.driedSingers.size) {
      for (const [id, was] of this.driedSingers) {
        const s = this.state.strips[id];
        // Put it back only if nobody has set it since.
        if (s && (s.sends?.[bus] ?? 0) === 0) {
          s.sends[bus] = was;
          this.client.setFloat(paths.send(id, bus), was);
        }
      }
      this.driedSingers.clear();
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
    if (this.driedSingers?.size) out.push(`${[...this.driedSingers.keys()].map((id) => names[id] || `Ch ${id}`).join(', ')} talking: no reverb on ${this.driedSingers.size > 1 ? 'them' : 'their voice'}`);
    const rv = this.returns.get(this.settings.reverbFx);
    if (rv && rv.offsetDb < -1 && this.reason) out.push(`Reverb ${Math.round(rv.offsetDb)} dB ${this.reason}`);
    if (this.mode === 'worship' && this.song.delay && this.settings.delayFx) {
      const who = this.song.lead.map((id) => names[id] || `Ch ${id}`);
      const bpm = this.tempo();
      const ms = this.conf('delay') && this.lastDelayMs ? this.lastDelayMs : delayMsFor(bpm, this.settings.delayNote);
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
      reverbTiming: this.conf('reverb') ? { ...reverbTiming(this.tempo()), offsets: this.settings.verbOffsets } : null,
      delayNoteNow: this.tempo() ? DELAY_NOTES[delayNoteFor(this.tempo(), this.settings.delayNote)].label : null,
      delaySetMs: this.conf('delay') ? (this.lastDelayMs ?? null) : null,
      running: {
        reverb: this.conf('reverb') ? this.desk?.describe('reverb', this.conf('reverb')) : null,
        delay: this.conf('delay') ? this.desk?.describe('delay', this.conf('delay')) : null,
      },
    };
  }
}
