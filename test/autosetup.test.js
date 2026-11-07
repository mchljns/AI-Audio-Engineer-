import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { channelName } from '../src/naming.js';
import { classifyName } from '../src/roles.js';
import { applyGain, freshModel } from '../src/tone.js';
import { FxDesk, PROFILES } from '../src/fxsetup.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

test('channel names: person + instrument, always read back as the right kind of channel', () => {
  assert.equal(channelName('Sarah Lee', 'vocal'), 'Sarah Vox');
  assert.equal(channelName('Ann Park', 'vocal'), 'Vox A.', '"Ann" would read as announcements');
  assert.equal(channelName('Ann Park', 'keys', 'L'), 'Keys A. L');
  assert.equal(channelName('Joe Kim', 'electric', 'R'), 'Joe EG R');
  assert.equal(channelName('Rev Smith', 'vocal'), 'Vox', '"Rev" would read as the pastor');
  for (const [n, i, want] of [['Christopher Ray', 'vocal', 'vocal'], ['Mike Ross', 'acoustic', 'acoustic'], ['Click Clack', 'keys', 'keys'], ['Guide Me', 'vocal', 'vocal']]) {
    const name = channelName(n, i);
    assert.equal(classifyName(name), want, `${n} → ${name}`);
    assert.ok(name.length <= 12);
  }
});

test('gain: loudest part brought to about −15 dB, compressor and gate follow, at most 12 dB a press', () => {
  const m = { ...freshModel('vocal'), gainDb: 20, comp: { on: true, thr: -20 }, gate: { on: true, thr: -55 } };
  let r = applyGain(m, -24);
  assert.equal(r.model.gainDb, 29);
  assert.equal(r.model.comp.thr, -11, 'compressor threshold moves with the gain');
  assert.equal(r.model.gate.thr, -46);
  assert.match(r.note, /Gain up 9 dB to \+29 dB/);
  r = applyGain(m, -45);
  assert.equal(r.model.gainDb, 32, '12 dB at most per press');
  r = applyGain({ ...m, gainDb: 55 }, -40);
  assert.equal(r.model.gainDb, 60);
  assert.match(r.note, /end of the range/);
  assert.match(applyGain(m, -15.5).note, /right already/);
});

test('effect setup: tries, and "No" puts back exactly what was there', async () => {
  const sent = [];
  const client = new EventEmitter();
  client.setFloat = (a, v) => sent.push([a, v]);
  client.setInt = (a, v) => sent.push([a, v]);
  // The "mixer" answers queries with Hall (0) and every parameter at 0.37.
  client.query = (a) => setImmediate(() => client.emit('message', { address: a, args: [{ value: a.endsWith('/type') ? 0 : 0.37 }] }));
  const desk = new FxDesk({ client });
  let shown = await desk.trySetup('delay', 2, { time: 500 });
  assert.equal(shown.label, 'Stereo delay');
  assert.ok(shown.shows.includes('Time 500 ms') && shown.shows.includes('Mix 100 %'));
  assert.deepEqual(sent.find(([a]) => a === '/fx/2/type'), ['/fx/2/type', 10]);
  shown = await desk.trySetup('delay', 2, { time: 500 }); // "No": second way
  assert.ok(Math.abs(sent.filter(([a]) => a === '/fx/2/par/02').at(-1)[1] - 499 / 2999) < 1e-9, 'linear Time on the second try');
  assert.equal(await desk.trySetup('delay', 2, { time: 500 }), null, 'out of tries');
  assert.deepEqual(sent.filter(([a]) => a === '/fx/2/type').at(-1), ['/fx/2/type', 0], 'algorithm put back');
  assert.equal(sent.filter(([a]) => a === '/fx/2/par/02').at(-1)[1], 0.37, 'parameters put back');

  await desk.trySetup('reverb', 1);
  const conf = desk.confirm('reverb');
  assert.deepEqual(conf, { fx: 1, attempt: 0 });
  assert.ok(Math.abs(desk.value('reverb', conf, 'decay') - 1.6) < 1e-6);
  assert.match(desk.tweak(conf, 'washy'), /Decay 1.4 s, Pre-delay 38 ms/);
  for (let i = 0; i < 10; i++) desk.tweak(conf, 'cave');
  assert.ok(Math.abs(desk.value('reverb', conf, 'decay') - PROFILES.plate.params.decay.min) < 1e-6, 'never shorter than the limit');
  assert.ok(desk.undoTweak(conf));
  assert.match(desk.describe('reverb', conf), /Pre-delay 38 ms · Decay/);
});

test('bridge: gain set, channels named, reverb set up and confirmed, delay time follows the tempo', async (t) => {
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
  const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
  await wait(900);
  await cmd({ type: 'savePerson', person: { name: 'Ann Park', instruments: [{ type: 'vocal' }] } });
  const ann = bridge.snapshot().setlist.people[0];
  await cmd({ type: 'newSet', title: 'Sunday' });
  await cmd({ type: 'setLineup', slotId: 'vox1', personId: ann.id });
  await cmd({ type: 'setSetChannel', slotId: 'vox1', left: '9', right: '' });

  await cmd({ type: 'toneRead', slotId: 'vox1' });
  await cmd({ type: 'toneGain', slotId: 'vox1', loudDb: -27 });
  await wait();
  assert.ok(Math.abs(sim.state.get('/headamp/09/gain').value - (32 + 12) / 72) < 1e-6, 'gain +20 → +32 dB on the mixer');
  assert.equal(sim.state.get('/headamp/09/phantom'), undefined, 'phantom never touched');

  await cmd({ type: 'channelsDone', done: true });
  await wait();
  assert.equal(sim.state.get('/ch/09/config/name').value, 'Vox A.');
  assert.equal(sim.state.get('/ch/15/config/name').value, 'Click', 'click untouched');

  await cmd({ type: 'fxSetup', kind: 'reverb' });
  await wait(1200);
  let E = bridge.snapshot().effects;
  assert.equal(E.ask.kind, 'reverb');
  assert.equal(sim.state.get('/fx/1/type').value, 5, 'plate');
  await cmd({ type: 'fxAnswer', kind: 'reverb', ok: true });
  E = bridge.snapshot().effects;
  assert.equal(E.ask, null);
  assert.match(E.running.reverb, /Decay 1.6 s/);
  await cmd({ type: 'fxTweak', id: 'muddy' });
  await wait();
  assert.ok(Math.abs(sim.state.get('/fx/1/par/07').value - Math.log(300 / 10) / Math.log(50)) < 1e-6, 'reverb low cut 300 Hz on the mixer');
  assert.match(bridge.snapshot().effects.note, /Low cut 300 Hz/);

  await cmd({ type: 'fxSetup', kind: 'delay' });
  await wait(1200);
  await cmd({ type: 'fxAnswer', kind: 'delay', ok: true });
  await cmd({ type: 'addSong', title: 'Holy Forever' });
  await cmd({ type: 'setSongDelay', index: 0, delay: true, bpm: 120 });
  await cmd({ type: 'playSong', index: 0 });
  for (let i = 0; i < 30 && !bridge.snapshot().effects.delaySetMs; i++) await wait(200);
  assert.ok(Math.abs(bridge.snapshot().effects.delaySetMs - 375) <= 3, `delay set to ${bridge.snapshot().effects.delaySetMs} ms`);
});
