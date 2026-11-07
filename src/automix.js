// The automatic mix engineer.
//
// Three jobs, all driven by the channel meters (~20 times a second):
//   1. Speech auto-mix: Dugan-style gain sharing across the speech mics (pastor,
//      announcements). The mic being talked into stays at its set level; the others
//      are turned down by how far they sit below the combined level, so the total
//      gain stays constant (less hiss, less feedback, no fighting mics).
//   2. Service modes: works out before-after / worship / talking over music / speaking
//      from which kinds of channels are active, with hold times so a pause between
//      songs doesn't flip the mode.
//   3. Mode actions: ducks the band and tracks under speech in "talking over music",
//      and mutes singer mics during a sermon (cuts their hiss and feedback risk),
//      unmuting them the moment music comes back.
//
// Safety rules:
//   - It only ever turns channels DOWN from the level a person set ("home"). It never
//     boosts, so it can't add feedback.
//   - A person always wins. Moving a fader (in this app, the X Air app, anywhere) sets
//     a new home level for that channel. Unmuting a channel it muted hands it back.
//   - Its state is saved. If the app restarts, every fader goes back to its home level
//     and anything it muted is unmuted before it carries on.

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { paths, STRIP_IDS } from './xair/addresses.js';
import { dbToFloat, floatToDb } from './xair/faderLaw.js';
import { resolveRole } from './inventory.js';
import { ROLES } from './roles.js';

export const MODES = {
  walkin: { label: 'Before / after', hint: 'Music before and after the service' },
  worship: { label: 'Worship', hint: 'Band and singers' },
  talkover: { label: 'Talking over music', hint: 'Announcements, prayer, transitions' },
  speaking: { label: 'Speaking', hint: 'Sermon, announcements without music' },
  idle: { label: 'Quiet', hint: 'Nothing happening' },
};

const DEFAULTS = {
  speechAutomix: true,
  duckMusic: true,
  muteSingersWhenSpeaking: true,
  autoModes: true,
  maxCutDb: 15, // gain sharing never turns a speech mic down more than this
  duckDb: 8, // how far the band and tracks come down under speech
  activeAboveFloorDb: 12, // a channel is "active" this far above its own noise floor…
  activeMinDb: -50, // …and above this absolute level
  modeHoldMs: { worship: 2500, talkover: 1500, speaking: 6000, walkin: 4000 },
  muteSingersAfterMs: 20000, // speaking this long before singer mics are muted
  speechHoldMs: 1500, // speech counts as active this long after the last word
  musicHoldMs: 4000, // music counts as active this long after the last note
  vocalHoldMs: 2500, // singing counts as active this long after the last line
  metersPostFader: false, // set true if the mixer's meters turn out to be post-fader
};

const SPEECH_ROLES = new Set(['pastor', 'speech']);
const VOCAL_ROLES = new Set(['vocal']);
const MUSIC_GROUPS = new Set(['band', 'tracks']);
const NOISE_FLOOR_CAP_DB = -60; // a channel's hiss is never assumed louder than this
const MIN_STEP_DB = 0.25; // don't send fader moves smaller than this
const HUMAN_MOVE_TOLERANCE = 0.02; // fader float difference that counts as a person moving it

export class AutoMix extends EventEmitter {
  constructor({ state, client, roleStore, isLocked = () => false, isFading = () => false, stateFile = null, settings = {}, onAlert = () => {} }) {
    super();
    this.isFading = isFading;
    this.state = state;
    this.client = client;
    this.roleStore = roleStore;
    this.isLocked = isLocked;
    this.stateFile = stateFile;
    this.onAlert = onAlert;
    this.settings = { ...DEFAULTS, ...settings, modeHoldMs: { ...DEFAULTS.modeHoldMs, ...(settings.modeHoldMs ?? {}) } };
    this.enabled = false;

    this.ch = new Map(); // id -> { home, offsetDb, targetDb, lastSent, env, floor, lastActive }
    this.mode = 'idle';
    this.modeLocked = null; // a mode a person picked; null = automatic
    this.candidate = null;
    this.candidateSince = 0;
    this.speakingSince = 0;
    // Singer mics turned down in the room for the sermon: id -> the fader level to put back.
    // Done with the channel FADER, never the mute: with pre-fader sends the in-ear mixes are untouched.
    this.pulled = new Map();
    this.keepOpen = new Set(); // singers a person turned back up: left alone until the mode changes
    this.lastSaveAt = 0;
    this.dirty = false;

    this.onChange = (e) => this.#onMixerChange(e);
    state.on('change', this.onChange);
  }

  // ---------- lifecycle ----------

  /** Start after the first full sync: undo anything a previous run left behind, then run. */
  start() {
    this.#restoreFromFile();
    this.enabled = true;
  }

  stop() {
    this.enabled = false;
    this.state.off('change', this.onChange);
  }

  /** Put every channel back where a person left it. Used on restart and when turned off. */
  releaseAll(reason = '') {
    for (const [id, c] of this.ch) {
      if (Math.abs(c.offsetDb) > 0.05 && c.home > 0) this.#sendFader(id, c.home);
      c.offsetDb = 0;
      c.targetDb = 0;
    }
    this.#restoreSingers();
    this.dirty = true;
    this.#save(true);
    if (reason) this.emit('note', reason);
  }

  // ---------- settings from the app ----------

  update(partial) {
    const before = { ...this.settings };
    for (const k of ['speechAutomix', 'duckMusic', 'muteSingersWhenSpeaking', 'autoModes', 'metersPostFader']) {
      if (typeof partial[k] === 'boolean') this.settings[k] = partial[k];
    }
    if (Number.isFinite(partial.duckDb)) this.settings.duckDb = Math.min(15, Math.max(2, partial.duckDb));
    if (Number.isFinite(partial.maxCutDb)) this.settings.maxCutDb = Math.min(25, Math.max(6, partial.maxCutDb));
    // Turning a feature off hands its channels straight back.
    if (before.speechAutomix && !this.settings.speechAutomix) this.#releaseGroup('speech');
    if (before.duckMusic && !this.settings.duckMusic) this.#releaseGroup('music');
    if (before.muteSingersWhenSpeaking && !this.settings.muteSingersWhenSpeaking) this.#restoreSingers();
    return this.settings;
  }

  /** A person picks a mode (or null to go back to automatic). */
  setMode(mode) {
    if (mode === null || mode === 'auto') {
      this.modeLocked = null;
      return;
    }
    if (!MODES[mode] || mode === 'idle') return;
    this.modeLocked = mode;
    this.#enterMode(mode, Date.now());
  }

  /** A person moved a fader from this app. Same rule as a move from anywhere else. */
  humanFader(id, value) {
    const c = this.ch.get(id);
    if (!c) return false;
    c.home = this.#homeFrom(value, c.offsetDb);
    c.lastSent = value;
    this.dirty = true;
    return true;
  }

  // ---------- main loop ----------

  /** Call on every meter update. `now` is injectable for tests. */
  tick(now = Date.now()) {
    if (!this.enabled) return;
    const groups = this.#classify();
    this.#trackLevels(groups.all, now);

    const speechActive = groups.speech.some((id) => now - this.ch.get(id).lastActive < this.settings.speechHoldMs);
    const musicActive = groups.music.some((id) => now - this.ch.get(id).lastActive < this.settings.musicHoldMs);
    const vocalsActive = groups.vocal.some((id) => now - this.ch.get(id).lastActive < this.settings.vocalHoldMs);
    const walkinActive = groups.walkin.some((id) => this.state.strips[id].on && now - this.ch.get(id).lastActive < this.settings.musicHoldMs);
    // Someone talking on a singer's mic with no music (worship leader praying, closing words).
    const vocalTalking = vocalsActive && !musicActive;
    const talking = speechActive || vocalTalking;
    this.activity = { speechActive, musicActive, vocalsActive, walkinActive, vocalTalking };

    // Modes
    if (!this.modeLocked && this.settings.autoModes) {
      let want = this.mode;
      if (musicActive && (vocalsActive || !speechActive)) want = 'worship';
      else if (musicActive && speechActive) want = 'talkover';
      else if (talking) want = 'speaking';
      else if (walkinActive) want = 'walkin';
      // nothing active: keep the current mode (pauses between songs, between sentences)
      if (want !== this.mode) {
        if (this.candidate !== want) {
          this.candidate = want;
          this.candidateSince = now;
        } else if (now - this.candidateSince >= (this.settings.modeHoldMs[want] ?? 3000)) {
          this.#enterMode(want, now);
        }
      } else this.candidate = null;
    }

    // Speech auto-mix (gain sharing)
    if (this.settings.speechAutomix && groups.speech.length >= 2) this.#gainShare(groups.speech, now);

    // Ducking under speech
    const duck = this.settings.duckMusic && this.mode === 'talkover' && speechActive && musicActive ? -this.settings.duckDb : 0;
    for (const id of groups.music) this.ch.get(id).targetDb = duck;
    // Pre/post-service music comes down under a welcome or closing words, whatever the mode.
    const duckWalkin = this.settings.duckMusic && talking ? -this.settings.duckDb : 0;
    for (const id of groups.walkin) this.ch.get(id).targetDb = duckWalkin;

    // Singer mics during a sermon
    if (this.settings.muteSingersWhenSpeaking) {
      if (this.mode === 'speaking' && this.speakingSince && now - this.speakingSince >= this.settings.muteSingersAfterMs) {
        for (const id of groups.vocal) {
          const s = this.state.strips[id];
          const c = this.ch.get(id);
          const silentFor = now - c.lastActive;
          if (s.fader > 0 && !this.pulled.has(id) && !this.keepOpen.has(id) && silentFor >= this.settings.muteSingersAfterMs) {
            // Only a mic nobody has used for the whole wait is turned down.
            this.pulled.set(id, s.fader);
            this.#sendFader(id, 0);
          } else if (this.pulled.has(id) && silentFor < 300) {
            // Someone started talking into a mic we turned down: bring it straight back.
            // The meters read the input before the fader, so this sees them even while it's down.
            this.#restoreSinger(id);
            this.keepOpen.add(id);
            this.onAlert({ level: 'info', source: 'automix', message: `${s.name || `Ch ${id}`} started talking, so it's back up.` });
          }
        }
      } else if (this.mode !== 'speaking' && this.pulled.size) this.#restoreSingers();
    }

    // Move faders toward their targets
    for (const id of [...groups.speech, ...groups.music, ...groups.walkin]) this.#apply(id, groups.speech.includes(id));
    this.#save(false, now);
  }

  // ---------- internals ----------

  #classify() {
    const g = { speech: [], vocal: [], music: [], walkin: [], all: [] };
    for (const id of STRIP_IDS) {
      const s = this.state.strips[id];
      if (!s.synced || this.isLocked(id) || this.isFading(id)) continue;
      const { role } = resolveRole(s, this.roleStore);
      const group = ROLES[role]?.group;
      let bucket = null;
      if (SPEECH_ROLES.has(role)) bucket = 'speech';
      else if (VOCAL_ROLES.has(role)) bucket = 'vocal';
      else if (role === 'walkin') bucket = 'walkin';
      else if (MUSIC_GROUPS.has(group)) bucket = 'music';
      if (!bucket) continue;
      g[bucket].push(id);
      g.all.push(id);
      if (!this.ch.has(id)) {
        this.ch.set(id, { home: s.fader, offsetDb: 0, targetDb: 0, lastSent: s.fader, env: -128, floor: -70, lastActive: 0 });
      }
    }
    // Channels that stopped being managed (renamed, role changed) are handed back.
    for (const id of [...this.ch.keys()]) {
      if (!g.all.includes(id)) {
        const c = this.ch.get(id);
        // A channel being faded (walk-in) belongs to the fade: don't jump it back first.
        if (!this.isFading(id) && Math.abs(c.offsetDb) > 0.05 && c.home > 0) this.#sendFader(id, c.home);
        this.ch.delete(id);
        if (this.pulled.has(id)) this.#restoreSinger(id);
      }
    }
    return g;
  }

  #trackLevels(ids, now) {
    for (const id of ids) {
      const c = this.ch.get(id);
      const s = this.state.strips[id];
      // Input level: meters are assumed pre-fader; if they're post-fader, take the fader back out.
      let level = s.levelDb;
      if (this.settings.metersPostFader && s.faderDb > -90) level -= s.faderDb;
      // Envelope: jumps up, falls ~40 dB/s.
      c.env = Math.max(level, c.env - 2);
      // Noise floor: drops straight to quiet moments, creeps up very slowly (~0.1 dB/s), and is
      // capped well below real sound, so a long steady pad or held note never becomes "silence".
      c.floor = Math.min(NOISE_FLOOR_CAP_DB, level < c.floor ? level : Math.min(c.floor + 0.005, level));
      c.level = level;
      if (c.env > this.settings.activeMinDb && c.env > c.floor + this.settings.activeAboveFloorDb) c.lastActive = now;
    }
  }

  #gainShare(ids, now) {
    const live = ids.filter((id) => this.state.strips[id].on);
    if (live.length < 2) {
      for (const id of ids) this.ch.get(id).targetDb = 0;
      return;
    }
    const anyoneTalking = live.some((id) => now - this.ch.get(id).lastActive < 250);
    if (!anyoneTalking) return; // last-mic hold: keep the last talker up between sentences
    let sum = 0;
    for (const id of live) sum += 10 ** (Math.max(this.ch.get(id).env, this.ch.get(id).floor) / 10);
    for (const id of live) {
      const c = this.ch.get(id);
      const share = 10 * Math.log10(10 ** (Math.max(c.env, c.floor) / 10) / sum);
      c.targetDb = Math.max(-this.settings.maxCutDb, Math.min(0, share));
    }
  }

  #apply(id, isSpeech) {
    const c = this.ch.get(id);
    if (!c || !(c.home > 0)) return; // fader all the way down: nothing to manage
    const s = this.state.strips[id];
    if (!s.on) return;
    const up = c.targetDb > c.offsetDb;
    // Speech: open fast, close gently. Music duck: down in ~0.3 s, back up in ~1.5 s.
    // Music comes back up gently after speech, but fast when worship starts so the first notes aren't quiet.
    const rate = isSpeech ? (up ? 0.6 : 0.2) : up ? (this.mode === 'worship' ? 0.3 : 0.06) : 0.25;
    let next = c.offsetDb + (c.targetDb - c.offsetDb) * rate;
    if (Math.abs(c.targetDb - next) < 0.1) next = c.targetDb;
    next = Math.min(0, next); // never boost
    if (Math.abs(next - c.offsetDb) < 0.01) return;
    c.offsetDb = next;
    const value = dbToFloat(floatToDb(c.home) + c.offsetDb);
    if (Math.abs(floatToDb(value) - floatToDb(c.lastSent)) >= MIN_STEP_DB || next === c.targetDb) this.#sendFader(id, value);
  }

  #sendFader(id, value) {
    const c = this.ch.get(id);
    if (c) c.lastSent = value;
    const s = this.state.strips[id];
    s.fader = value;
    s.faderDb = floatToDb(value);
    this.client.setFloat(paths.fader(id), value);
    this.dirty = true;
  }

  /** Put one turned-down singer back, unless a person has moved that fader since. */
  #restoreSinger(id) {
    const from = this.pulled.get(id);
    this.pulled.delete(id);
    const s = this.state.strips[id];
    if (from > 0 && s && s.fader <= HUMAN_MOVE_TOLERANCE) this.#sendFader(id, from);
    this.dirty = true;
  }

  #restoreSingers() {
    for (const id of [...this.pulled.keys()]) this.#restoreSinger(id);
  }

  #homeFrom(value, offsetDb) {
    if (value <= 0) return 0;
    return dbToFloat(Math.min(10, floatToDb(value) - offsetDb));
  }

  #onMixerChange({ id, field }) {
    if (!id || !this.ch.has(id)) return;
    const c = this.ch.get(id);
    const s = this.state.strips[id];
    if (field === 'fader' && Math.abs(s.fader - c.lastSent) > HUMAN_MOVE_TOLERANCE && this.pulled.has(id)) {
      // Someone brought up a singer we'd turned down: they're in charge of it now.
      this.pulled.delete(id);
      this.keepOpen.add(id);
      c.lastSent = s.fader;
      this.dirty = true;
      return;
    }
    if (field === 'fader' && Math.abs(s.fader - c.lastSent) > HUMAN_MOVE_TOLERANCE) {
      // Someone moved it: that's the new level this channel should sit at.
      c.home = this.#homeFrom(s.fader, c.offsetDb);
      c.lastSent = s.fader;
      this.dirty = true;
    }
  }

  #enterMode(mode, now) {
    if (mode === this.mode) return;
    const from = this.mode;
    this.mode = mode;
    this.candidate = null;
    this.speakingSince = mode === 'speaking' ? now : 0;
    this.keepOpen.clear();
    if (mode !== 'speaking') this.#restoreSingers();
    this.emit('mode', { mode, from, auto: !this.modeLocked });
  }


  #releaseGroup(which) {
    const groups = this.#classify();
    for (const id of which === 'speech' ? groups.speech : groups.music) {
      const c = this.ch.get(id);
      if (Math.abs(c.offsetDb) > 0.05 && c.home > 0) this.#sendFader(id, c.home);
      c.offsetDb = 0;
      c.targetDb = 0;
    }
  }

  // ---------- persistence (so a restart never leaves anything stuck) ----------

  #save(force = false, now = Date.now()) {
    if (!this.stateFile || !this.dirty) return;
    if (!force && now - this.lastSaveAt < 1000) return;
    this.lastSaveAt = now;
    this.dirty = false;
    const data = {
      savedAt: new Date().toISOString(),
      homes: Object.fromEntries([...this.ch].map(([id, c]) => [id, { home: c.home, offsetDb: c.offsetDb }])),
      pulled: Object.fromEntries(this.pulled),
    };
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify(data));
    } catch {
      /* best effort */
    }
  }

  #restoreFromFile() {
    if (!this.stateFile) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return;
    }
    let restored = 0;
    for (const [id, { home, offsetDb }] of Object.entries(data.homes ?? {})) {
      const s = this.state.strips[id];
      if (!s || !(home > 0) || Math.abs(offsetDb) < 0.05) continue;
      // Only put it back if nobody has moved it since: the fader is still where we left it.
      const leftAt = dbToFloat(floatToDb(home) + offsetDb);
      if (Math.abs(s.fader - leftAt) <= HUMAN_MOVE_TOLERANCE) {
        s.fader = home;
        s.faderDb = floatToDb(home);
        this.client.setFloat(paths.fader(id), home);
        restored++;
      }
    }
    for (const [id, from] of Object.entries(data.pulled ?? {})) {
      const s = this.state.strips[id];
      // Still down where we left it: put it back. If someone moved it, leave it.
      if (s && from > 0 && s.fader <= HUMAN_MOVE_TOLERANCE) {
        s.fader = from;
        s.faderDb = floatToDb(from);
        this.client.setFloat(paths.fader(id), from);
        restored++;
      }
    }
    try {
      fs.unlinkSync(this.stateFile);
    } catch {
      /* gone already */
    }
    if (restored) this.onAlert({ level: 'info', source: 'automix', message: `Put ${restored} channel${restored > 1 ? 's' : ''} back where they were before the restart.` });
  }

  /** The level a person set for this channel, before any auto-mix cut (dB), or null. */
  homeDb(id) {
    const c = this.ch.get(id);
    return c && c.home > 0 ? floatToDb(c.home) : null;
  }

  // ---------- for the app ----------

  status() {
    const chans = [...this.ch].map(([id, c]) => ({
      id,
      name: this.state.strips[id]?.name ?? '',
      offsetDb: Math.round(c.offsetDb * 10) / 10,
      active: Date.now() - c.lastActive < 1500,
      mutedByAuto: this.pulled.has(id), // turned down in the room for the sermon
    }));
    return {
      enabled: this.enabled,
      mode: this.mode,
      modeLabel: MODES[this.mode].label,
      modeLocked: this.modeLocked,
      candidate: this.candidate,
      settings: {
        speechAutomix: this.settings.speechAutomix,
        duckMusic: this.settings.duckMusic,
        muteSingersWhenSpeaking: this.settings.muteSingersWhenSpeaking,
        autoModes: this.settings.autoModes,
        duckDb: this.settings.duckDb,
      },
      activity: this.activity ?? {},
      channels: chans,
      modes: Object.fromEntries(Object.entries(MODES).filter(([k]) => k !== 'idle').map(([k, v]) => [k, v])),
    };
  }
}
