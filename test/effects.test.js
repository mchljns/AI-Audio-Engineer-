import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MixerState } from '../src/mixerState.js';
import { RoleStore } from '../src/inventory.js';
import { Effects, delayTimes, fxSendBus } from '../src/effects.js';
import { Library } from '../src/library.js';
import { dbToFloat, floatToDb } from '../src/xair/faderLaw.js';

const NAMES = { 1: 'Pastor', 2: 'Announce', 3: 'Vox 1', 4: 'Vox 2' };

function rig(settings = {}) {
  const state = new MixerState();
  for (const s of Object.values(state.strips)) {
    s.synced = true;
    s.name = NAMES[s.id] ?? '';
    s.sends = {};
  }
  const sent = [];
  const client = new EventEmitter();
  client.setFloat = (a, v) => sent.push([a, v]);
  client.query = () => {};
  const alerts = [];
  const fx = new Effects({ state, client, roleStore: new RoleStore(null), settings, onAlert: (a) => alerts.push(a) });
  fx.start();
  // The mixer answers: reverb and delay returns at −5 dB.
  for (const n of [1, 2]) client.emit('message', { address: `/rtn/${n}/mix/fader`, args: [{ value: dbToFloat(-5) }] });
  const run = (mode, n = 40, activity = {}) => {
    for (let i = 0; i < n; i++) fx.tick({ mode, activity });
  };
  const lastSent = (addr) => [...sent].reverse().find(([a]) => a === addr)?.[1];
  return { state, fx, client, sent, alerts, run, lastSent };
}

test('effects: the pastor is always dry; announcements dry by default', () => {
  const { state, run, alerts, lastSent } = rig();
  state.strips['1'].sends[fxSendBus(1)] = dbToFloat(-10);
  state.strips['2'].sends[fxSendBus(1)] = dbToFloat(-10);
  state.strips['3'].sends[fxSendBus(1)] = dbToFloat(-12);
  run('worship', 2);
  assert.equal(lastSent('/ch/01/mix/07/level'), 0, 'pastor dry');
  assert.equal(lastSent('/ch/02/mix/07/level'), 0, 'announcements dry');
  assert.equal(lastSent('/ch/03/mix/07/level'), undefined, 'singers keep their reverb');
  assert.equal(alerts.length, 2);
  state.strips['1'].sends[fxSendBus(1)] = dbToFloat(-10);
  run('worship', 2);
  assert.equal(alerts.length, 2, 'told once, still kept dry');
  assert.equal(state.strips['1'].sends[fxSendBus(1)], 0);
  const r2 = rig({ speechDry: false });
  r2.state.strips['2'].sends[fxSendBus(1)] = dbToFloat(-10);
  r2.run('worship', 2);
  assert.equal(r2.lastSent('/ch/02/mix/07/level'), undefined, 'announcement reverb allowed when switched');
});

test('effects follow the service: down while talking, well down for the sermon, back for worship; never past home', () => {
  const { fx, run, client, lastSent } = rig();
  run('worship');
  assert.equal(lastSent('/rtn/1/mix/fader'), undefined, 'worship: left where the person set it');
  run('talkover');
  assert.ok(Math.abs(floatToDb(lastSent('/rtn/1/mix/fader')) - -11) < 0.3, 'reverb −6 dB under talking');
  assert.ok(Math.abs(floatToDb(lastSent('/rtn/2/mix/fader')) - -11) < 0.3, 'delay too');
  assert.match(fx.describe().join(' '), /Reverb -6 dB while someone talks/);
  run('speaking');
  assert.ok(Math.abs(floatToDb(lastSent('/rtn/1/mix/fader')) - -20) < 0.3, 'sermon −15 dB');
  run('worship', 80);
  assert.ok(Math.abs(floatToDb(lastSent('/rtn/1/mix/fader')) - -5) < 0.2, 'back for worship');
  run('worship', 20, { vocalTalking: true });
  assert.ok(floatToDb(lastSent('/rtn/1/mix/fader')) < -8, 'worship leader talking between songs');
  run('worship', 80);
  // A person turns the reverb up to −2: that's where it sits now.
  client.emit('message', { address: '/rtn/1/mix/fader', args: [{ value: dbToFloat(-2) }] });
  assert.ok(Math.abs(fx.returnDb(1) - -2) < 0.2);
  assert.ok(Math.abs(fx.nudgeReturn(1, -1.5) - -3.5) < 0.2, 'Too much reverb: −1.5 dB');
});

test('light delay: only the lead singer, only on marked songs, only during worship', () => {
  const { fx, run, lastSent } = rig();
  fx.setSong({ delay: true, lead: ['3'], amounts: {}, bpm: 72 });
  run('worship', 2);
  assert.ok(Math.abs(floatToDb(lastSent('/ch/03/mix/08/level')) - -16) < 0.1, 'lead gets a light delay send');
  assert.equal(lastSent('/ch/04/mix/08/level'), undefined, 'other singers none');
  assert.match(fx.describe({ 3: 'Sarah' }).join(' '), /Light delay on Sarah \(625 ms at 72 BPM\)/);
  run('talkover', 2);
  assert.equal(lastSent('/ch/03/mix/08/level'), 0, 'off while talking');
  fx.setSong({ delay: false, lead: ['3'] });
  run('worship', 2);
  assert.equal(lastSent('/ch/03/mix/08/level'), 0, 'not on songs without delay');
  fx.setSong({ delay: true, lead: ['3'], amounts: { 3: -11 } });
  run('worship', 2);
  assert.ok(Math.abs(floatToDb(lastSent('/ch/03/mix/08/level')) - -11) < 0.1, "uses the person's saved amount");
  assert.deepEqual(delayTimes(120), { bpm: 120, quarter: 500, dottedEighth: 375 });
  assert.equal(delayTimes(10), null);
});

test('songs remember delay and tempo; setting leads keeps them; a person can opt out of delay', () => {
  const lib = new Library(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-')), 'l.json'));
  const sarah = lib.savePerson({ name: 'Sarah', instruments: [{ type: 'vocal' }] });
  lib.newSet({ title: 'W1' });
  lib.setLineup('vox1', sarah.id);
  lib.addSong({ title: 'Holy Forever', bpm: 72 });
  assert.equal(lib.set().songs[0].bpm, 72, 'tempo from Planning Center');
  lib.setSongDelay(0, { delay: true, bpm: 74 });
  lib.setSongLeads(0, { lead: sarah.id, harmonies: [] });
  lib.playSong(0);
  let e = lib.songEffects();
  assert.deepEqual([e.delay, e.bpm, e.lead], [true, 74, ['3']]);
  lib.newSet({ title: 'W2' });
  lib.setLineup('vox1', sarah.id);
  lib.addSong({ title: 'Holy Forever' });
  assert.deepEqual([lib.set().songs[0].delay, lib.set().songs[0].bpm], [true, 74], 'remembered next week');
  lib.savePersonTone(sarah.id, 'vocal', { delayOff: true, delayDb: null });
  lib.playSong(0);
  e = lib.songEffects();
  assert.deepEqual(e.lead, [], 'Sarah opted out of delay');
});
