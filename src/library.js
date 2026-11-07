// People, the channels each stage position uses, service sets, and what each song needs.
//
//   slots    a stage position and its XR18 channel(s): "Vox 1" → ch 3, "Keys" → ch 7 + 8
//   people   who plays or sings what (acoustic can be mono or stereo per person)
//   sets     a service: who's on which position, the songs in order, and per song the
//            lead singer, harmonies and lead instrument. A set can also move a position
//            to different channels for that week (packs and inputs change week to week).
//   songs    remembered per song, so the next time it's played the leads are filled in
//
// The song mix only ever turns channels down from the level a person set (see automix.js).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { STRIP_IDS } from './xair/addresses.js';

export const INSTRUMENTS = {
  vocal: { label: 'Vocals', stereo: 'never' },
  keys: { label: 'Keys', stereo: 'always' },
  acoustic: { label: 'Acoustic guitar', stereo: 'choice' },
  electric: { label: 'Electric guitar', stereo: 'always' },
  bass: { label: 'Bass', stereo: 'never' },
  drums: { label: 'Drums', stereo: 'never' },
  other: { label: 'Other', stereo: 'choice' },
};

export const DEFAULT_SLOTS = [
  { id: 'vox1', name: 'Vox 1', instrument: 'vocal', left: '3', right: '' },
  { id: 'vox2', name: 'Vox 2', instrument: 'vocal', left: '4', right: '' },
  { id: 'vox3', name: 'Vox 3', instrument: 'vocal', left: '5', right: '' },
  { id: 'vox4', name: 'Vox 4', instrument: 'vocal', left: '', right: '' },
  { id: 'keys', name: 'Keys', instrument: 'keys', left: '7', right: '8' },
  { id: 'acoustic', name: 'Acoustic', instrument: 'acoustic', left: '6', right: '14' },
  { id: 'electric', name: 'Electric', instrument: 'electric', left: '12', right: '13' },
];

export const DEFAULT_MIX = { harmonyDb: -4, otherVocalDb: -10, otherInstrumentDb: -3 };

const newId = () => crypto.randomBytes(6).toString('hex');
const clean = (v, n = 60) => String(v ?? '').trim().slice(0, n);
const validCh = (c) => (c === '' || STRIP_IDS.includes(String(c)) ? String(c) : '');
export const songKey = (title, pcoSongId) => (pcoSongId ? `pco:${pcoSongId}` : `t:${clean(title, 120).toLowerCase().replace(/\s+/g, ' ')}`);

export class Library {
  constructor(file) {
    this.file = file;
    this.data = { slots: DEFAULT_SLOTS.map((s) => ({ ...s })), people: [], sets: [], currentSet: null, currentSong: null, songs: {}, mix: { ...DEFAULT_MIX } };
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...saved, mix: { ...DEFAULT_MIX, ...(saved.mix ?? {}) } };
    } catch {
      /* first run */
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  // ---------- channels (stage positions) ----------

  saveSlot(slot) {
    const instrument = INSTRUMENTS[slot?.instrument] ? slot.instrument : 'other';
    const name = clean(slot?.name, 24) || INSTRUMENTS[instrument].label;
    const s = { id: slot?.id && this.slot(slot.id) ? slot.id : newId(), name, instrument, left: validCh(slot?.left ?? ''), right: INSTRUMENTS[instrument].stereo === 'never' ? '' : validCh(slot?.right ?? '') };
    const i = this.data.slots.findIndex((x) => x.id === s.id);
    if (i >= 0) this.data.slots[i] = s;
    else if (this.data.slots.length < 24) this.data.slots.push(s);
    this.save();
    return s;
  }

  deleteSlot(id) {
    this.data.slots = this.data.slots.filter((s) => s.id !== id);
    for (const set of this.data.sets) {
      delete set.lineup[id];
      for (const song of set.songs) if (song.leadInstrument === id) song.leadInstrument = null;
    }
    this.save();
  }

  slot(id) {
    return this.data.slots.find((s) => s.id === id) ?? null;
  }

  // ---------- people ----------

  savePerson(p) {
    const instruments = [];
    for (const it of Array.isArray(p?.instruments) ? p.instruments : []) {
      if (!INSTRUMENTS[it?.type] || instruments.some((x) => x.type === it.type)) continue;
      const mode = INSTRUMENTS[it.type].stereo;
      instruments.push({ type: it.type, stereo: mode === 'always' ? true : mode === 'never' ? false : !!it.stereo });
    }
    const existing = p?.id ? this.person(p.id) : null;
    const person = { id: existing ? existing.id : newId(), name: clean(p?.name, 40) || 'Unnamed', instruments, pcoId: existing?.pcoId ?? (p?.pcoId ? String(p.pcoId) : null) };
    const i = this.data.people.findIndex((x) => x.id === person.id);
    if (i >= 0) this.data.people[i] = person;
    else if (this.data.people.length < 200) this.data.people.push(person);
    this.save();
    return person;
  }

  deletePerson(id) {
    this.data.people = this.data.people.filter((p) => p.id !== id);
    for (const set of this.data.sets) {
      for (const [slotId, pid] of Object.entries(set.lineup)) if (pid === id) delete set.lineup[slotId];
      for (const song of set.songs) {
        if (song.lead === id) song.lead = null;
        song.harmonies = song.harmonies.filter((h) => h !== id);
      }
    }
    this.save();
  }

  person(id) {
    return this.data.people.find((p) => p.id === id) ?? null;
  }

  // ---------- sets ----------

  newSet({ title, date, pco = null } = {}) {
    const set = { id: newId(), title: clean(title, 80) || 'Sunday', date: clean(date, 20), pco, lineup: {}, channels: {}, channelsDone: false, songs: [] };
    this.data.sets.unshift(set);
    this.data.sets = this.data.sets.slice(0, 30);
    this.data.currentSet = set.id;
    this.data.currentSong = null;
    this.save();
    return set;
  }

  set(id = this.data.currentSet) {
    return this.data.sets.find((s) => s.id === id) ?? null;
  }

  openSet(id) {
    if (!this.set(id)) return;
    this.data.currentSet = id;
    this.data.currentSong = null;
    this.save();
  }

  deleteSet(id) {
    this.data.sets = this.data.sets.filter((s) => s.id !== id);
    if (this.data.currentSet === id) {
      this.data.currentSet = this.data.sets[0]?.id ?? null;
      this.data.currentSong = null;
    }
    this.save();
  }

  /** A position with this set's channels: the week's channel if one was picked, else the usual one. */
  slotIn(set, slot) {
    const o = set?.channels?.[slot?.id];
    return o ? { ...slot, left: o.left, right: o.right, usual: { left: slot.left, right: slot.right } } : slot;
  }

  /** This week only: move a position to other channels. left '' clears it back to the usual channels. */
  setSetChannel(slotId, left, right = '') {
    const set = this.set();
    const slot = this.slot(slotId);
    if (!set || !slot) return;
    set.channels ??= {};
    const l = validCh(left ?? '');
    if (!l) delete set.channels[slotId];
    else set.channels[slotId] = { left: l, right: INSTRUMENTS[slot.instrument]?.stereo === 'never' ? '' : validCh(right ?? '') };
    // Remember it for this person, as next week's first guess.
    const pid = set.lineup[slotId];
    if (pid && l) (this.data.personChannels ??= {})[`${pid}:${slot.instrument}`] = set.channels[slotId];
    this.save();
  }

  /** Someone was put on a position: start from the channel they used last time, if we know it. */
  #placed(set, slotId, personId) {
    const slot = this.slot(slotId);
    const last = this.data.personChannels?.[`${personId}:${slot?.instrument}`];
    set.channels ??= {};
    if (last) set.channels[slotId] = { ...last };
    else delete set.channels[slotId];
  }

  /** Channels are checked once a week: done for this set, or not yet. */
  setChannelsDone(done) {
    const set = this.set();
    if (!set) return;
    set.channelsDone = !!done;
    this.save();
  }

  /** The song in this set whose title matches a ProPresenter presentation name, or -1. */
  matchSong(name) {
    const set = this.set();
    const norm = (t) =>
      String(t ?? '')
        .toLowerCase()
        .replace(/\(.*?\)|\[.*?\]/g, ' ') // "(Live)", "[A]"
        .split(/\s[-–|:]\s/)[0] // "Holy Forever - Chris Tomlin"
        .replace(/&/g, 'and')
        .replace(/[^a-z0-9]+/g, '');
    const want = norm(name);
    if (!set || want.length < 3) return -1;
    const titles = set.songs.map((s) => norm(s.title));
    let i = titles.indexOf(want);
    if (i < 0) i = titles.findIndex((t) => t.length >= 4 && (want.startsWith(t) || t.startsWith(want)));
    return i;
  }

  /**
   * This week, does this person sing / play this instrument? On: put them on a free position for it.
   * Off: take them off every position of that kind. Returns false when there's no free position.
   */
  placePerson(personId, type, on) {
    const set = this.set();
    if (!set || !this.person(personId) || !INSTRUMENTS[type]) return false;
    const ofType = this.data.slots.filter((s) => s.instrument === type);
    if (!on) {
      for (const s of ofType) {
        if (set.lineup[s.id] !== personId) continue;
        delete set.lineup[s.id];
        delete set.channels?.[s.id];
      }
      this.save();
      return true;
    }
    if (ofType.some((s) => set.lineup[s.id] === personId)) return true;
    const free = ofType.find((s) => !set.lineup[s.id] && s.left) ?? ofType.find((s) => !set.lineup[s.id]);
    if (!free) return false;
    this.#placed(set, free.id, personId);
    set.lineup[free.id] = personId;
    this.save();
    return true;
  }

  setLineup(slotId, personId) {
    const set = this.set();
    if (!set || !this.slot(slotId)) return;
    if (personId && this.person(personId)) {
      if (set.lineup[slotId] !== personId) this.#placed(set, slotId, personId);
      set.lineup[slotId] = personId;
    } else {
      delete set.lineup[slotId];
      delete set.channels?.[slotId];
    }
    this.save();
  }

  addSong({ title, key = '', pcoSongId = null } = {}) {
    const set = this.set();
    const t = clean(title, 120);
    if (!set || !t || set.songs.length >= 40) return;
    const k = songKey(t, pcoSongId);
    const mem = this.data.songs[k] ?? {};
    set.songs.push({ id: newId(), title: t, key: clean(key, 8), songKey: k, lead: this.#onStage(set, mem.lead) ? mem.lead : null, harmonies: (mem.harmonies ?? []).filter((h) => this.#onStage(set, h)), leadInstrument: mem.leadInstrument && set.lineup[mem.leadInstrument] ? mem.leadInstrument : null });
    this.save();
  }

  #onStage(set, personId) {
    return !!personId && Object.values(set.lineup).includes(personId);
  }

  removeSong(index) {
    const set = this.set();
    if (!set?.songs[index]) return;
    set.songs.splice(index, 1);
    if (this.data.currentSong !== null) {
      if (this.data.currentSong === index) this.data.currentSong = null;
      else if (this.data.currentSong > index) this.data.currentSong--;
    }
    this.save();
  }

  moveSong(index, dir) {
    const set = this.set();
    const j = index + (dir < 0 ? -1 : 1);
    if (!set?.songs[index] || !set.songs[j]) return;
    [set.songs[index], set.songs[j]] = [set.songs[j], set.songs[index]];
    if (this.data.currentSong === index) this.data.currentSong = j;
    else if (this.data.currentSong === j) this.data.currentSong = index;
    this.save();
  }

  /** Lead singer, harmonies and lead instrument for one song; remembered for next time. */
  setSongLeads(index, { lead, harmonies, leadInstrument } = {}) {
    const set = this.set();
    const song = set?.songs[index];
    if (!song) return;
    if (lead !== undefined) song.lead = lead && this.person(lead) ? lead : null;
    if (harmonies !== undefined) song.harmonies = [...new Set((Array.isArray(harmonies) ? harmonies : []).filter((h) => this.person(h) && h !== song.lead))];
    else song.harmonies = song.harmonies.filter((h) => h !== song.lead);
    if (leadInstrument !== undefined) song.leadInstrument = leadInstrument && this.slot(leadInstrument) ? leadInstrument : null;
    this.data.songs[song.songKey] = { title: song.title, lead: song.lead, harmonies: song.harmonies, leadInstrument: song.leadInstrument };
    this.save();
  }

  playSong(index) {
    const set = this.set();
    this.data.currentSong = set && Number.isInteger(index) && set.songs[index] ? index : null;
    this.save();
  }

  nextSong() {
    const set = this.set();
    if (!set?.songs.length) return;
    const cur = this.data.currentSong;
    this.data.currentSong = cur === null ? 0 : cur + 1 < set.songs.length ? cur + 1 : null;
    this.save();
  }

  setMix(partial = {}) {
    for (const k of Object.keys(DEFAULT_MIX)) {
      const v = Number(partial[k]);
      if (Number.isFinite(v)) this.data.mix[k] = Math.max(-20, Math.min(0, v));
    }
    this.save();
  }

  // ---------- the song mix ----------

  /** Channels a person uses on a stage position (stereo pairs only when that person plays stereo). */
  channelsFor(slot, personId) {
    slot = this.slotIn(this.set(), slot);
    if (!slot?.left) return [];
    const mode = INSTRUMENTS[slot.instrument]?.stereo;
    let stereo = mode === 'always';
    if (mode === 'choice') stereo = !!this.person(personId)?.instruments.find((i) => i.type === slot.instrument)?.stereo;
    return stereo && slot.right ? [slot.left, slot.right] : [slot.left];
  }

  /** For vocal riding and the status line: the current song's lead singer channel(s), and who is on each channel. */
  songContext() {
    const set = this.set();
    const song = set && this.data.currentSong !== null ? set.songs[this.data.currentSong] : null;
    const lead = [];
    const names = {};
    for (const slot of this.data.slots) {
      const pid = set?.lineup[slot.id];
      if (!pid) continue;
      const name = this.person(pid)?.name?.split(' ')[0];
      const chans = this.channelsFor(slot, pid);
      for (const ch of chans) names[ch] = slot.instrument === 'vocal' ? name : `${name}'s ${slot.name.toLowerCase()}`;
      if (song?.lead === pid && slot.instrument === 'vocal') lead.push(...chans);
    }
    return { lead, names };
  }

  /** { channelId: dB } for the current song. Empty when no song is playing. */
  focusForCurrentSong() {
    const set = this.set();
    const song = set && this.data.currentSong !== null ? set.songs[this.data.currentSong] : null;
    if (!song) return {};
    const out = {};
    const { harmonyDb, otherVocalDb, otherInstrumentDb } = this.data.mix;
    // A lead who isn't on a vocal mic this week (only playing) doesn't count: leave the singers alone.
    const onMic = (pid) => this.data.slots.some((x) => x.instrument === 'vocal' && set.lineup[x.id] === pid);
    const lead = song.lead && onMic(song.lead) ? song.lead : null;
    for (const slot of this.data.slots) {
      const pid = set.lineup[slot.id];
      if (!pid) continue;
      let db = 0;
      if (slot.instrument === 'vocal') {
        if (!lead) db = 0; // no lead chosen (or not singing this week): leave the singers alone
        else if (pid === lead) db = 0;
        else if (song.harmonies.includes(pid)) db = harmonyDb;
        else db = otherVocalDb;
      } else if (song.leadInstrument) {
        db = slot.id === song.leadInstrument ? 0 : otherInstrumentDb;
      }
      for (const ch of this.channelsFor(slot, pid)) out[ch] = db;
    }
    return out;
  }

  // ---------- Planning Center import ----------

  /** Bring in a plan: people (matched by Planning Center id), the lineup and the songs. */
  importPlan({ title, date, serviceTypeId, planId, songs = [], team = [] }) {
    const set = this.newSet({ title, date, pco: { serviceTypeId, planId } });
    const unplaced = [];
    for (const m of team) {
      if (m.status === 'D') continue; // declined
      const type = instrumentFromPosition(m.position);
      if (!type) continue;
      let person = this.data.people.find((p) => p.pcoId && p.pcoId === String(m.personId)) ?? this.data.people.find((p) => !p.pcoId && p.name.toLowerCase() === String(m.name).toLowerCase());
      const instruments = [...(person?.instruments ?? [])];
      if (!instruments.some((i) => i.type === type)) instruments.push({ type, stereo: INSTRUMENTS[type].stereo === 'always' });
      person = this.savePerson({ id: person?.id, name: m.name, instruments, pcoId: m.personId });
      if (!person.pcoId && m.personId) person.pcoId = String(m.personId);
      const slot = this.data.slots.find((s) => s.instrument === type && !set.lineup[s.id]);
      if (slot) {
        this.#placed(set, slot.id, person.id);
        set.lineup[slot.id] = person.id;
      }
      else unplaced.push(`${m.name} (${m.position})`);
    }
    for (const s of songs) this.addSong({ title: s.title, key: s.key, pcoSongId: s.songId });
    this.save();
    return { set, unplaced };
  }

  snapshot() {
    return { ...this.data, instruments: INSTRUMENTS };
  }
}

/** Planning Center position names → instrument. Acoustic before electric, so "Acoustic Guitar" isn't electric. */
export function instrumentFromPosition(position) {
  const p = String(position ?? '').toLowerCase();
  if (/vocal|vox|sing|bgv|harmony|worship lead/.test(p)) return 'vocal';
  if (/key|piano|synth|organ/.test(p)) return 'keys';
  if (/acoustic|\bag\b/.test(p)) return 'acoustic';
  if (/electric|\beg\b|lead guitar|guitar/.test(p)) return 'electric';
  if (/bass/.test(p)) return 'bass';
  if (/drum|percussion|cajon/.test(p)) return 'drums';
  return null; // sound, lights, slides, etc. aren't on stage
}
