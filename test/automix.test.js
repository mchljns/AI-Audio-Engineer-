import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MixerState } from '../src/mixerState.js';
import { RoleStore } from '../src/inventory.js';
import { AutoMix } from '../src/automix.js';
import { dbToFloat, floatToDb } from '../src/xair/faderLaw.js';

const NAMES = { 1: 'Pastor', 2: 'Announce', 3: 'Vox 1', 4: 'Vox 2', 6: 'Ac Gtr', 7: 'Keys L', 9: 'Trk 1', aux: 'Walk-in' };

function rig({ stateFile = null, settings = {} } = {}) {
  const state = new MixerState();
  for (const s of Object.values(state.strips)) {
    s.synced = true;
    s.name = NAMES[s.id] ?? '';
    s.fader = dbToFloat(0);
    s.faderDb = 0;
    s.on = true;
  }
  const sent = [];
  const client = {
    setFloat: (a, v) => sent.push([a, v]),
    setInt: (a, v) => sent.push([a, v]),
  };
  const mix = new AutoMix({ state, client, roleStore: new RoleStore(null), stateFile, settings });
  mix.start();
  let now = 1_000_000;
  const levels = Object.fromEntries(Object.keys(state.strips).map((id) => [id, -85]));
  // Run the engine for `ms` with the given channel levels (20 updates a second).
  const run = (set, ms) => {
    Object.assign(levels, set);
    for (let t = 0; t < ms; t += 50) {
      now += 50;
      state.applyMeters(levels, now);
      mix.tick(now);
    }
  };
  const offset = (id) => mix.ch.get(id)?.offsetDb ?? 0;
  return { state, mix, run, offset, sent, levels };
}

test('one person talking: their mic stays up, the other speech mic comes down', () => {
  const { run, offset } = rig();
  run({ 1: -20, 2: -60 }, 3000);
  assert.ok(offset('1') > -1, `pastor ${offset('1')}`);
  assert.ok(offset('2') <= -14, `announce ${offset('2')}`);
});

test('two people talking equally share the gain (about -3 dB each)', () => {
  const { run, offset } = rig();
  run({ 1: -20, 2: -20 }, 3000);
  assert.ok(Math.abs(offset('1') + 3) < 1, `${offset('1')}`);
  assert.ok(Math.abs(offset('2') + 3) < 1, `${offset('2')}`);
});

test('last mic hold: between sentences the last talker stays up', () => {
  const { run, offset } = rig();
  run({ 1: -20, 2: -60 }, 2000);
  run({ 1: -75, 2: -75 }, 1000); // pause
  assert.ok(offset('1') > -1, `pastor ${offset('1')}`);
});

test('never boosts: offsets are always zero or below', () => {
  const { run, mix } = rig();
  run({ 1: -10, 2: -40, 6: -15, 9: -15 }, 4000);
  for (const c of mix.ch.values()) assert.ok(c.offsetDb <= 0);
});

test('service flow: walk-in → worship → talking over music (ducked) → speaking (singers muted) → worship', () => {
  const { run, mix, offset, state } = rig();
  run({ aux: -15 }, 5000);
  assert.equal(mix.mode, 'walkin');

  run({ aux: -85, 6: -15, 7: -15, 9: -18, 3: -18 }, 5000);
  assert.equal(mix.mode, 'worship');
  assert.equal(offset('6'), 0, 'no ducking during worship');

  run({ 3: -85, 7: -25, 6: -85, 9: -85, 2: -20 }, 6000); // announcer over quiet keys
  assert.equal(mix.mode, 'talkover');
  assert.ok(offset('7') <= -7, `keys ducked ${offset('7')}`);

  run({ 7: -85, 2: -85, 1: -18 }, 11000); // sermon starts (music hold 4 s + speaking hold 6 s)
  assert.equal(mix.mode, 'speaking');
  assert.ok(offset('7') > -1, 'duck released');
  assert.equal(state.strips['3'].on, true, 'singers not muted yet');
  run({}, 20000);
  assert.equal(state.strips['3'].on, false, 'singers muted after 20 s of speaking');
  assert.equal(state.strips['4'].on, false);

  run({ 1: -85, 6: -15, 7: -15 }, 5000); // band comes back
  assert.equal(mix.mode, 'worship');
  assert.equal(state.strips['3'].on, true, 'singers unmuted for worship');
});

test('a long steady pad is still counted as music', () => {
  const { run, mix } = rig();
  run({ 7: -20 }, 120000);
  assert.ok(mix.activity.musicActive, 'two minutes of steady keys is still music');
});

test('a short prayer between songs does not mute the singers', () => {
  const { run, mix, state } = rig();
  run({ 6: -15, 3: -18 }, 5000);
  run({ 6: -85, 3: -85, 1: -18 }, 12000);
  assert.equal(mix.mode, 'speaking');
  assert.equal(state.strips['3'].on, true);
});

test('a person moving a fader sets a new home level, and the automix works from there', () => {
  const { run, mix, state, offset } = rig();
  run({ 1: -20, 2: -60 }, 3000);
  const cut = offset('2');
  // Someone pushes the announce fader to -5 dB in the X Air app.
  state.strips['2'].fader = dbToFloat(-5);
  state.strips['2'].faderDb = -5;
  state.emit('change', { id: '2', field: 'fader' });
  assert.ok(Math.abs(floatToDb(mix.ch.get('2').home) - (-5 - cut)) < 0.6, 'home = their level without our cut');
});

test('a person unmuting a singer the app muted takes it back', () => {
  const { run, mix, state } = rig();
  run({ 1: -18 }, 30000);
  assert.equal(state.strips['3'].on, false);
  state.strips['3'].on = true;
  state.emit('change', { id: '3', field: 'on' });
  run({}, 2000);
  assert.equal(state.strips['3'].on, true, 'not muted again');
  assert.ok(!mix.mutedByAuto.has('3'));
});

test('turning a feature off hands the channels straight back', () => {
  const { run, mix, offset } = rig();
  run({ 1: -20, 2: -60 }, 3000);
  assert.ok(offset('2') < -10);
  mix.update({ speechAutomix: false });
  assert.equal(offset('2'), 0);
});

test('a person picking a mode overrides the automatic choice', () => {
  const { run, mix } = rig();
  mix.setMode('speaking');
  run({ 6: -15, 3: -18 }, 6000);
  assert.equal(mix.mode, 'speaking');
  mix.setMode('auto');
  run({}, 5000);
  assert.equal(mix.mode, 'worship');
});

test('after a restart, faders it had turned down and singers it muted are put back', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-')), 'automix-state.json');
  const a = rig({ stateFile: file });
  a.run({ 1: -18, 2: -70 }, 30000); // speaking: announce cut, singers muted
  a.run({}, 1100); // let it save
  assert.equal(a.state.strips['3'].on, false);
  assert.ok(a.state.strips['2'].faderDb < -10);
  assert.ok(fs.existsSync(file));
  a.mix.stop(); // the app "crashes" here: nothing is undone

  // Restart: a new engine meets the mixer exactly as the old one left it.
  const sent = [];
  const mix2 = new AutoMix({ state: a.state, client: { setFloat: (...x) => sent.push(x), setInt: (...x) => sent.push(x) }, roleStore: new RoleStore(null), stateFile: file });
  mix2.start();
  assert.equal(a.state.strips['3'].on, true, 'singer unmuted after restart');
  assert.ok(Math.abs(a.state.strips['2'].faderDb) < 0.6, `announce back at home (${a.state.strips['2'].faderDb})`);
  assert.ok(sent.length > 0, 'changes sent to the mixer');
});

test('worship leader talking on a singer mic after the sermon is not muted', () => {
  const { run, mix, state } = rig();
  run({ 1: -18 }, 30000); // sermon: singers muted
  assert.equal(state.strips['3'].on, false);
  // Pastor finishes; worship leader (Vox 1) prays with no music.
  run({ 1: -85, 3: -20 }, 1000);
  assert.equal(state.strips['3'].on, true, 'muted singer who starts talking is unmuted');
  run({}, 30000);
  assert.equal(state.strips['3'].on, true, 'and stays open while talking');
  assert.equal(mix.mode, 'speaking');
});

test('a singer talking during the speaking part is never muted in the first place', () => {
  const { run, state } = rig();
  run({ 2: -20, 3: -22 }, 40000); // announcer and worship leader both talking, no music
  assert.equal(state.strips['3'].on, true);
  assert.equal(state.strips['4'].on, false, 'the unused singer mic is muted');
});

test('walk-in music is turned down under a welcome and comes back after', () => {
  const { run, offset } = rig();
  run({ aux: -15 }, 5000);
  run({ 2: -20 }, 3000); // "Good morning, welcome…"
  assert.ok(offset('aux') <= -7, `walk-in ducked ${offset('aux')}`);
  run({ 2: -85 }, 8000);
  assert.ok(offset('aux') > -1, `walk-in back up ${offset('aux')}`);
});
