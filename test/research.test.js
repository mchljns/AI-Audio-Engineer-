import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Library } from '../src/library.js';
import { MixerState } from '../src/mixerState.js';
import { RoleStore } from '../src/inventory.js';
import { Effects, delayMsFor, delayNoteFor, reverbTiming, fxSendBus } from '../src/effects.js';
import { FxDesk } from '../src/fxsetup.js';
import { dbToFloat } from '../src/xair/faderLaw.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r-')), 'l.json');

test('harmony size compensation: 3 dB down per doubling of harmony singers', () => {
  const lib = new Library(tmp());
  const p = ['A', 'B', 'C', 'D'].map((n) => lib.savePerson({ name: n, instruments: [{ type: 'vocal' }] }));
  lib.newSet({ title: 'S' });
  p.forEach((x) => lib.placePerson(x.id, 'vocal', true)); // ch 3, 4, 5 (Vox 4 has no channel)
  lib.setSetChannel('vox4', '10');
  lib.addSong({ title: 'One' });
  lib.playSong(0);
  lib.setSongLeads(0, { lead: p[0].id, harmonies: [p[1].id] });
  assert.equal(lib.focusForCurrentSong()['4'], -4, 'one harmony: the usual −4');
  lib.setSongLeads(0, { lead: p[0].id, harmonies: [p[1].id, p[2].id] });
  assert.equal(lib.focusForCurrentSong()['4'], -7, 'two: −4 − 3');
  lib.setSongLeads(0, { lead: p[0].id, harmonies: [p[1].id, p[2].id, p[3].id] });
  const f = lib.focusForCurrentSong();
  assert.equal(f['5'], -8.8, 'three: −4 − 4.8');
  assert.equal(f['3'], 0, 'the lead stays');
});

test('delay note by tempo: short 1/16 on fast songs, dotted-1/8 throw on slow; reverb timed to the song', () => {
  assert.equal(delayNoteFor(128), 'sixteenth');
  assert.equal(delayMsFor(128), 117);
  assert.equal(delayNoteFor(72), 'dotted8');
  assert.equal(delayMsFor(72), 625);
  assert.equal(delayMsFor(72, 'quarter'), 833, 'a fixed choice still works');
  assert.deepEqual(reverbTiming(72), { decay: 1.7, preDelay: 80 }, 'slow: half note 1.67 s');
  assert.deepEqual(reverbTiming(128), { decay: 1.2, preDelay: 59 }, 'fast: clamped to 1.2 s');
  assert.deepEqual(reverbTiming(null), { decay: 1.6, preDelay: 60 });
});

function rig() {
  const state = new MixerState();
  for (const s of Object.values(state.strips)) {
    s.synced = true;
    s.name = { 3: 'Vox 1', 4: 'Vox 2' }[s.id] ?? '';
    s.sends = {};
  }
  const sent = [];
  const client = new EventEmitter();
  client.setFloat = (a, v) => sent.push([a, v]);
  client.setInt = (a, v) => sent.push([a, v]);
  client.query = () => {};
  const fx = new Effects({ state, client, roleStore: new RoleStore(null) });
  fx.desk = new FxDesk({ client });
  return { state, fx, sent };
}

test('talking singer goes dry: their reverb send to zero while talking, back for the next song', () => {
  const { state, fx, sent } = rig();
  const bus = fxSendBus(1);
  state.strips['3'].sends[bus] = dbToFloat(-12);
  state.strips['4'].sends[bus] = dbToFloat(-12);
  fx.tick({ mode: 'worship', activity: { vocalTalking: true }, talkers: ['3'] });
  assert.equal(state.strips['3'].sends[bus], 0, 'Sarah talking: dry');
  assert.equal(state.strips['4'].sends[bus], dbToFloat(-12), 'others keep theirs');
  assert.match(fx.describe({ 3: 'Sarah' }).join(' '), /Sarah talking: no reverb on their voice/);
  fx.tick({ mode: 'worship', activity: {}, talkers: [] });
  assert.equal(state.strips['3'].sends[bus], dbToFloat(-12), 'singing again: reverb back');
  assert.ok(sent.some(([a, v]) => a === '/ch/03/mix/07/level' && v === 0));
});

test('reverb timed to the song, with a person\'s fixes kept on top', () => {
  const { fx, sent } = rig();
  fx.settings.fxConf = { reverb: { fx: 1, attempt: 0 }, delay: null };
  fx.setSong({ bpm: 72 });
  fx.tick({ mode: 'worship' });
  const last = (n) => sent.filter(([a]) => a === `/fx/1/par/0${n}`).at(-1)?.[1];
  assert.ok(Math.abs(last(2) - Math.log(1.7 / 0.5) / Math.log(20)) < 1e-9, 'decay 1.7 s at 72 BPM');
  assert.ok(Math.abs(last(1) - 80 / 200) < 1e-9, 'pre-delay 80 ms');
  fx.desk.tweak(fx.conf('reverb'), 'cave'); // decay −0.3
  fx.keepVerbFix();
  assert.equal(fx.settings.verbOffsets.decay, -0.3);
  fx.setSong({ bpm: 128 });
  fx.tick({ mode: 'worship' });
  assert.ok(Math.abs(last(2) - Math.log(0.9 / 0.5) / Math.log(20)) < 1e-9, 'next song: 1.2 s − 0.3 = 0.9 s');
});
