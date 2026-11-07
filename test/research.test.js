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

test('song sections from ProPresenter: verse leaves room for the vocal, chorus comes back with less reverb', async (t) => {
  const { XR18Simulator } = await import('../src/simulator/xr18-sim.js');
  const { Bridge } = await import('../src/bridge.js');
  const { groupAt, presentationGroups } = await import('../src/propresenter.js');
  const json = { presentation: { id: { name: 'Holy Forever' }, groups: [{ name: 'Verse 1', slides: [{}, {}] }, { name: 'Chorus', slides: [{}, {}] }, { name: 'Bridge', slides: [{}] }] } };
  assert.equal(groupAt(presentationGroups(json), 3), 'Chorus');
  assert.equal(groupAt(presentationGroups(json), 4), 'Bridge');
  assert.equal(groupAt(presentationGroups(json), 9), null);
  let slide = 0;
  const proFetch = async (url) => ({ ok: true, status: 200, json: async () => (url.endsWith('slide_index') ? { presentation_index: { index: slide } } : json) });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1, proFetch,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  const cmd = (c) => bridge.handleCommand(c, { local: false });
  const until = async (f) => {
    for (let i = 0; i < 40 && !f(); i++) await new Promise((r) => setTimeout(r, 150));
  };
  await new Promise((r) => setTimeout(r, 900));
  await cmd({ type: 'newSet', title: 'S' });
  await cmd({ type: 'addSong', title: 'Holy Forever' });
  await cmd({ type: 'proPresenter', host: '127.0.0.1', port: '1025', follow: true });
  await until(() => bridge.automix.section?.name === 'Verse 1');
  assert.deepEqual(bridge.automix.section, { kind: 'light', name: 'Verse 1' });
  assert.equal(bridge.snapshot().setlist.pro.section, 'Verse 1');
  slide = 2;
  await until(() => bridge.automix.section?.name === 'Chorus');
  assert.equal(bridge.automix.section.kind, 'full');
  assert.equal(bridge.effects.section, 'full');
  await cmd({ type: 'proPresenter', sections: false });
  assert.equal(bridge.automix.section, null, 'switched off: no section moves');
});

test('bass weeks: steady bass for 5 s flips to present; 30 s of silence back; a verse off does not', async () => {
  const { BassWatch } = await import('../src/basswatch.js');
  const b = new BassWatch();
  let t = 0;
  const run = (db, ms, worship = true) => {
    for (let i = 0; i < ms; i += 50) b.feed([db], worship, (t += 50));
  };
  run(-85, 3000);
  assert.equal(b.present, false);
  run(-20, 6000, false);
  assert.equal(b.present, false, 'only judged during songs');
  run(-20, 16000);
  assert.equal(b.present, true, 'bass playing');
  run(-85, 15000);
  assert.equal(b.present, true, 'laying out for a verse: still a bass week');
  run(-85, 30000);
  assert.equal(b.present, false, 'gone for 30 s+: no bass');
  b.present = true;
  b.feed([], true, (t += 50));
  assert.equal(b.present, false, 'nobody on a bass position: no bass');
});

test('bass weeks on the mixer: keys low cut raised between songs, put back exactly', async (t) => {
  const { XR18Simulator } = await import('../src/simulator/xr18-sim.js');
  const { Bridge } = await import('../src/bridge.js');
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  const cmd = (c) => bridge.handleCommand(c, { local: false });
  await new Promise((r) => setTimeout(r, 900));
  await cmd({ type: 'savePerson', person: { name: 'Ann', instruments: [{ type: 'keys' }] } });
  await cmd({ type: 'savePerson', person: { name: 'Bo', instruments: [{ type: 'bass' }] } });
  const [ann, bo] = bridge.snapshot().setlist.people;
  await cmd({ type: 'newSet', title: 'S' });
  await cmd({ type: 'setLineup', slotId: 'keys', personId: ann.id }); // ch 7/8
  await cmd({ type: 'setLineup', slotId: 'bass', personId: bo.id });
  await cmd({ type: 'setSetChannel', slotId: 'bass', left: '12', right: '' }); // the simulator plays ch 12 steadily
  bridge.bass = null;
  for (let i = 0; i < 60 && !bridge.bass?.present; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(bridge.bass.present, true, 'heard the bass');
  await cmd({ type: 'addSong', title: 'Next' });
  await cmd({ type: 'playSong', index: 0 }); // a song boundary
  for (let i = 0; i < 30 && sim.state.get('/ch/07/preamp/hpon').value !== 1; i++) await new Promise((r) => setTimeout(r, 150));
  const hz = (raw) => 20 * Math.exp(Math.log(20) * raw);
  assert.equal(sim.state.get('/ch/07/preamp/hpon').value, 1);
  assert.ok(Math.abs(hz(sim.state.get('/ch/07/preamp/hpf').value) - 120) < 0.5, 'keys low cut 120 Hz');
  assert.ok(Math.abs(hz(sim.state.get('/ch/08/preamp/hpf').value) - 120) < 0.5, 'both sides');
  assert.match(bridge.snapshot().automix.now.join(' '), /Bass playing/);
});
