import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, decodeMessage } from '../src/osc.js';
import { floatToDb, dbToFloat } from '../src/xair/faderLaw.js';
import { parseAddress, encodeMeterBlob, decodeMeterBlob } from '../src/xair/addresses.js';
import { classifyName, isDefaultName, stereoSide } from '../src/roles.js';

test('OSC round-trips every type the XR18 uses', () => {
  const blob = Buffer.from([1, 2, 3]);
  const buf = encodeMessage('/ch/01/mix/fader', [{ type: 'f', value: 0.75 }, 3, 'Vox 1', blob]);
  assert.equal(buf.length % 4, 0);
  const m = decodeMessage(buf);
  assert.equal(m.address, '/ch/01/mix/fader');
  assert.equal(m.args[0].value, 0.75);
  assert.equal(m.args[1].value, 3);
  assert.equal(m.args[2].value, 'Vox 1');
  assert.deepEqual([...m.args[3].value], [1, 2, 3]);
});

test('OSC query with no arguments', () => {
  const m = decodeMessage(encodeMessage('/xinfo'));
  assert.equal(m.address, '/xinfo');
  assert.deepEqual(m.args, []);
});

test('fader law matches the X Air curve', () => {
  assert.equal(floatToDb(0.75), 0);
  assert.equal(floatToDb(1), 10);
  assert.equal(floatToDb(0), -Infinity);
  for (const db of [10, 0, -5, -10, -20, -30, -45, -60, -80]) {
    assert.ok(Math.abs(floatToDb(dbToFloat(db)) - db) < 0.5, `round trip ${db}`);
  }
});

test('address parsing', () => {
  assert.deepEqual(parseAddress('/ch/15/mix/lr'), { id: '15', field: 'lr' });
  assert.deepEqual(parseAddress('/ch/03/mix/07/level'), { id: '3', field: 'send', bus: 7 });
  assert.deepEqual(parseAddress('/rtn/aux/config/name'), { id: 'aux', field: 'name' });
  assert.deepEqual(parseAddress('/dca/2/fader'), { dca: 2, field: 'fader' });
  assert.equal(parseAddress('/fx/1/type'), null);
});

test('meter blob round trip', () => {
  const vals = decodeMeterBlob(encodeMeterBlob([-20, -60.5, 0]));
  assert.deepEqual(vals.map((v) => Math.round(v * 2) / 2), [-20, -60.5, 0]);
});

test('channel names are recognised', () => {
  const cases = {
    Click: 'click', CLK: 'click', Metronome: 'click',
    Guide: 'guide', Cues: 'guide',
    PSTR: 'pastor', 'Pastor Dave': 'pastor',
    Announce: 'speech', Podium: 'speech',
    'Vox 1': 'vocal', Vox2: 'vocal', BV3: 'vocal', 'Lead Vox': 'vocal',
    'Ac Gtr': 'acoustic', AG: 'acoustic',
    'Keys L': 'keys', Piano: 'keys',
    'Trk 1': 'track', Tracks: 'track', Pads: 'track',
    'Walk-in': 'walkin', 'Pre Service': 'walkin', Spotify: 'walkin', 'Pre/Post': 'walkin', 'Post Service': 'walkin',
    Sarah: 'unknown',
    '': 'none', Ch01: 'none', 'CH 12': 'none',
  };
  for (const [name, role] of Object.entries(cases)) assert.equal(classifyName(name), role, name);
});

test('click/guide win over other matches', () => {
  assert.equal(classifyName('Click Trk'), 'click');
  assert.equal(classifyName('Guide Vox'), 'guide');
});

test('default names and stereo sides', () => {
  assert.ok(isDefaultName('Ch 05'));
  assert.ok(!isDefaultName('Vox 5'));
  assert.equal(stereoSide('Keys L'), 'L');
  assert.equal(stereoSide('Keys R'), 'R');
  assert.equal(stereoSide('Vox 1'), null);
});

test('your gear names are recognised', async () => {
  const { classifyName } = await import('../src/roles.js');
  for (const [n, r] of [['NUX AG', 'acoustic'], ['Stageman', 'acoustic']]) assert.equal(classifyName(n), r, n);
  assert.deepEqual(parseAddress('/ch/07/mix/pan'), { id: '7', field: 'pan' });
});
