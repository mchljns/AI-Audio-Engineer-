import test from 'node:test';
import assert from 'node:assert/strict';
import { MixerState } from '../src/mixerState.js';
import { RoleStore } from '../src/inventory.js';
import { AutoMix } from '../src/automix.js';
import { dbToFloat, floatToDb } from '../src/xair/faderLaw.js';

const NAMES = { 1: 'Pastor', 3: 'Vox 1', 4: 'Vox 2', 5: 'Vox 3', 6: 'Ac Gtr', 7: 'Keys L', 9: 'Trk 1' };

function rig(settings = {}) {
  const state = new MixerState();
  for (const s of Object.values(state.strips)) {
    s.synced = true;
    s.name = NAMES[s.id] ?? '';
    s.fader = dbToFloat(-5);
    s.faderDb = -5;
    s.on = true;
  }
  const alerts = [];
  const client = { setFloat: () => {}, setInt: () => {} };
  const mix = new AutoMix({ state, client, roleStore: new RoleStore(null), settings, onAlert: (a) => alerts.push(a) });
  mix.start();
  let now = 1_000_000;
  const levels = Object.fromEntries(Object.keys(state.strips).map((id) => [id, -85]));
  // Singing has small natural variation; `wobble` keeps that realistic.
  const run = (set, ms, wobble = 1) => {
    Object.assign(levels, set);
    for (let t = 0; t < ms; t += 50) {
      now += 50;
      const l = { ...levels };
      for (const k of Object.keys(l)) if (l[k] > -60) l[k] += (Math.random() - 0.5) * wobble;
      state.applyMeters(l, now);
      mix.tick(now);
    }
  };
  const offset = (id) => mix.ch.get(id)?.offsetDb ?? 0;
  return { state, mix, run, offset, alerts };
}

const band = { 6: -18, 7: -18, 9: -20 };

test('vocal riding: a lead who drops below their normal is brought up, within the limit', () => {
  const { mix, run, offset } = rig();
  mix.setFocus({}, { lead: ['3'], names: { 3: 'Sarah' } });
  run({ ...band, 3: -16 }, 20000); // learn Sarah's normal and the band's
  assert.equal(mix.mode, 'worship');
  assert.ok(Math.abs(offset('3')) < 1, `at normal: no move (${offset('3')})`);
  assert.match(mix.describe().join(' '), /Sarah leading: sitting right/);
  run({ 3: -22 }, 2500); // a quiet verse: 6 dB under her normal
  assert.ok(offset('3') > 2, `brought up (${offset('3')})`);
  assert.ok(offset('3') <= 4.01, `never past Normal's +4 (${offset('3')})`);
  assert.match(mix.describe().join(' '), /Keeping Sarah on top: Sarah \+/);
});

test('vocal riding: when the vocal can not make it up, the band comes down; a belting lead is eased back', () => {
  const { mix, run, offset } = rig();
  mix.setFocus({}, { lead: ['3'], names: { 3: 'Sarah' } });
  run({ ...band, 3: -16 }, 20000);
  run({ 3: -26 }, 3000); // 10 dB under normal: +4 on her, the rest from the band
  assert.ok(offset('3') > 3.5, `vocal at its limit (${offset('3')})`);
  assert.ok(offset('6') < -1.5 && offset('6') >= -3.01, `band down, within Normal's 3 dB (${offset('6')})`);
  assert.match(mix.describe().join(' '), /band −/);
  run({ 3: -16 }, 3000);
  assert.ok(Math.abs(offset('3')) < 1 && Math.abs(offset('6')) < 1, 'back to normal: everything returns');
  run({ 3: -9 }, 3000); // belting
  assert.ok(offset('3') < -2, `eased back (${offset('3')})`);
});

test('vocal riding: the boost only holds while singing, never on speech mics, never outside worship', () => {
  const { mix, run, offset } = rig();
  mix.setFocus({}, { lead: ['3'] });
  run({ ...band, 3: -16 }, 20000);
  run({ 3: -22 }, 2500);
  assert.ok(offset('3') > 2);
  run({ 3: -85 }, 600); // she stops
  assert.ok(offset('3') <= 0, `boost off as soon as she stops (${offset('3')})`);
  run({ 3: -85, 6: -85, 7: -85, 9: -85, 1: -20 }, 14000); // sermon
  assert.equal(mix.mode, 'speaking');
  for (const c of mix.ch.values()) assert.ok(c.offsetDb <= 0, 'nothing boosted outside worship');
});

test('vocal riding: a boosted mic climbing by itself (feedback) loses its boost for a minute', () => {
  const { mix, run, offset, alerts } = rig();
  mix.setFocus({}, { lead: ['3'], names: { 3: 'Sarah' } });
  run({ ...band, 3: -16 }, 20000);
  run({ 3: -22 }, 2500);
  assert.ok(offset('3') > 2);
  for (let db = -22; db <= -12; db += 1) run({ 3: db }, 100, 0); // steady climb: ringing
  assert.ok(alerts.some((a) => /possible feedback/.test(a.message)), 'warned');
  run({ 3: -24 }, 3000);
  assert.ok(offset('3') <= 0, `no boost while blocked (${offset('3')})`);
  assert.ok(offset('6') < -1, 'the band comes down instead');
});

test('vocal riding: off means no moves; Gentle stays within 2 dB; a fader move wins', () => {
  const off = rig({ ride: 'off' });
  off.mix.setFocus({}, { lead: ['3'] });
  off.run({ ...band, 3: -16 }, 20000);
  off.run({ 3: -24 }, 3000);
  assert.equal(off.offset('3'), 0);

  const g = rig({ ride: 'gentle' });
  g.mix.setFocus({}, { lead: ['3'] });
  g.run({ ...band, 3: -16 }, 20000);
  g.run({ 3: -30 }, 3000);
  assert.ok(g.offset('3') <= 2.01 && g.offset('3') > 1, `gentle +2 max (${g.offset('3')})`);
  assert.ok(g.offset('6') >= -2.01, `gentle band −2 max (${g.offset('6')})`);
  // The engineer pulls Sarah's fader: that's her new level.
  const s = g.state.strips['3'];
  s.fader = dbToFloat(-10);
  g.state.emit('change', { id: '3', field: 'fader' });
  assert.ok(Math.abs(floatToDb(g.mix.ch.get('3').home) - (-10 - g.offset('3'))) < 0.2, 'home follows the person');
});

test('no song lead: the singer carrying the song is followed; a full chorus favours nobody', () => {
  const { mix, run, offset } = rig();
  mix.setFocus({}, { names: { 3: 'Sarah', 4: 'Mike', 5: 'Ann' } });
  run({ ...band, 3: -16, 4: -16, 5: -16 }, 20000); // learn everyone
  assert.match(mix.describe().join(' '), /Everyone singing: nobody favoured/);
  for (const c of ['3', '4', '5']) assert.ok(Math.abs(offset(c)) < 1);
  run({ 4: -85, 5: -85 }, 3000); // Sarah alone on the verse
  assert.equal(mix.ride.lead, '3');
});
