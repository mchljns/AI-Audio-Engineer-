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
  const down = (id) => state.strips[id].fader <= 0.001; // turned down in the room
  return { state, mix, run, offset, sent, levels, down };
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

test('service flow: walk-in → worship → talking over music (ducked) → speaking (singers down) → worship', () => {
  const { run, mix, offset, state, down, sent } = rig();
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
  assert.ok(!down('3'), 'singers not down yet');
  run({}, 20000);
  assert.ok(down('3'), 'singers turned down in the room after 20 s of speaking');
  assert.ok(down('4'));
  assert.equal(state.strips['3'].on, true, 'channel never muted, so in-ear sends are untouched');
  assert.ok(!sent.some(([a]) => /\/mix\/on$/.test(a)), 'the auto-mix never sends a mute');
  assert.ok(!sent.some(([a]) => /\/mix\/0[1-6]\/level$/.test(a)), 'the auto-mix never touches an aux send');

  run({ 1: -85, 6: -15, 7: -15 }, 5000); // band comes back
  assert.equal(mix.mode, 'worship');
  assert.ok(Math.abs(state.strips['3'].faderDb) < 0.6, 'singers back at their level for worship');
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
  assert.ok(state.strips['3'].fader > 0);
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

test('a person bringing a turned-down singer back up takes it over', () => {
  const { run, mix, state, down } = rig();
  run({ 1: -18 }, 30000);
  assert.ok(down('3'));
  state.strips['3'].fader = dbToFloat(-5);
  state.strips['3'].faderDb = -5;
  state.emit('change', { id: '3', field: 'fader' });
  run({}, 2000);
  assert.ok(!down('3'), 'not turned down again');
  assert.ok(!mix.pulled.has('3'));
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
  a.run({ 1: -18, 2: -70 }, 30000); // speaking: announce cut, singers turned down
  a.run({}, 1100); // let it save
  assert.ok(a.down('3'));
  assert.ok(a.state.strips['2'].faderDb < -10);
  assert.ok(fs.existsSync(file));
  a.mix.stop(); // the app "crashes" here: nothing is undone

  // Restart: a new engine meets the mixer exactly as the old one left it.
  const sent = [];
  const mix2 = new AutoMix({ state: a.state, client: { setFloat: (...x) => sent.push(x), setInt: (...x) => sent.push(x) }, roleStore: new RoleStore(null), stateFile: file });
  mix2.start();
  assert.ok(Math.abs(a.state.strips['3'].faderDb) < 0.6, 'singer back at its level after restart');
  assert.ok(Math.abs(a.state.strips['2'].faderDb) < 0.6, `announce back at home (${a.state.strips['2'].faderDb})`);
  assert.ok(sent.length > 0, 'changes sent to the mixer');
});

test('worship leader talking on a singer mic after the sermon is brought back up', () => {
  const { run, mix, down } = rig();
  run({ 1: -18 }, 30000); // sermon: singers down
  assert.ok(down('3'));
  // Pastor finishes; worship leader (Vox 1) prays with no music.
  run({ 1: -85, 3: -20 }, 1000);
  assert.ok(!down('3'), 'singer who starts talking is brought straight back');
  run({}, 30000);
  assert.ok(!down('3'), 'and stays up while talking');
  assert.equal(mix.mode, 'speaking');
});

test('a singer talking during the speaking part is never turned down in the first place', () => {
  const { run, down } = rig();
  run({ 2: -20, 3: -22 }, 40000); // announcer and worship leader both talking, no music
  assert.ok(!down('3'));
  assert.ok(down('4'), 'the unused singer mic is turned down');
});

test('walk-in music is turned down under a welcome and comes back after', () => {
  const { run, offset } = rig();
  run({ aux: -15 }, 5000);
  run({ 2: -20 }, 3000); // "Good morning, welcome…"
  assert.ok(offset('aux') <= -7, `walk-in ducked ${offset('aux')}`);
  run({ 2: -85 }, 8000);
  assert.ok(offset('aux') > -1, `walk-in back up ${offset('aux')}`);
});

test('song mix: only during worship, only cuts, and a person still wins', () => {
  const { run, mix, offset, state } = rig();
  mix.setFocus({ 3: 0, 4: -4, 7: -3, 6: 0 });
  run({ 1: -18 }, 8000); // speaking: no song mix
  assert.equal(offset('4'), 0);
  run({ 1: -85, 6: -15, 7: -15, 3: -18, 4: -20 }, 5000); // worship
  assert.equal(mix.mode, 'worship');
  assert.ok(offset('4') < -3.5, `harmony back ${offset('4')}`);
  assert.ok(offset('7') < -2.5, `keys back ${offset('7')}`);
  assert.equal(offset('3'), 0, 'lead untouched');
  mix.setFocus({});
  run({}, 4000);
  assert.ok(offset('4') > -0.5, 'clearing the song brings everyone back');
  mix.update({ songMix: false });
  mix.setFocus({ 4: -10 });
  run({}, 3000);
  assert.ok(offset('4') > -0.5, 'switch off: no song mix');
  for (const c of mix.ch.values()) assert.ok(c.offsetDb <= 0);
  assert.ok(state.strips['4'].on);
});
