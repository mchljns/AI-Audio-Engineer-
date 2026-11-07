import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { modelFromRaw, messagesFor, applyFix, applyComp, applyGate, freshModel, describeTone, RATIOS, tonePaths } from '../src/tone.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

test('tone: values convert to and from the mixer exactly', () => {
  const m = freshModel('vocal');
  m.b1 = { type: 2, hz: 300, db: -4, q: 1.4 };
  m.comp = { on: true, mode: 0, thr: -22, ratio: 5, knee: 2, mgain: 2.5, attack: 10, release: 150, auto: true };
  const msgs = messagesFor('3', m);
  const raw = Object.fromEntries(msgs.map((x) => [x.address.replace('/ch/03/', ''), x.value]));
  assert.ok(msgs.every((x) => x.address.startsWith('/ch/03/')));
  assert.equal(raw['eq/1/type'], 2);
  assert.ok(Math.abs(raw['eq/1/g'] - (-4 + 15) / 30) < 1e-9, 'gain −15..+15 linear');
  assert.ok(raw['eq/1/q'] > 0 && raw['eq/1/q'] < 1, 'q inverted log');
  assert.equal(raw['dyn/ratio'], 5, 'ratio is an index');
  const back = modelFromRaw(raw);
  assert.ok(Math.abs(back.b1.hz - 300) < 0.01 && Math.abs(back.b1.db + 4) < 1e-6 && Math.abs(back.b1.q - 1.4) < 1e-6);
  assert.ok(Math.abs(back.hpHz - 100) < 0.01 && back.hpOn === true);
  assert.ok(Math.abs(back.comp.thr + 22) < 1e-6 && back.comp.on === true && RATIOS[back.comp.ratio] === 3);
  assert.deepEqual(messagesFor('3', m, back), [], 'nothing changed: nothing sent');
  assert.equal(tonePaths('3').length, 36, 'gain + low cut + EQ + compressor + gate');
});

test('fix buttons: small steps on the right frequency, bounded, low cut in steps', () => {
  let m = freshModel('vocal');
  let r = applyFix(m, 'vocal', 'muddy');
  assert.deepEqual([r.model.b1.hz, r.model.b1.db], [300, -2]);
  assert.match(r.note, /Muddy: −?-2 dB at 300 Hz/);
  for (let i = 0; i < 10; i++) r = applyFix(r.model, 'vocal', 'muddy');
  assert.equal(r.model.b1.db, -9, 'muddy stops at −9');
  assert.match(r.note, /already at the limit/);
  r = applyFix(r.model, 'vocal', 'thin');
  assert.deepEqual([r.model.b1.hz, r.model.b1.db], [200, 2], 'thin re-aims the low band');
  assert.equal(r.model.hpHz, 80, 'and lowers the low cut');
  m = applyFix(freshModel('vocal'), 'vocal', 'boomy').model;
  assert.equal(m.hpHz, 120, 'boomy raises the low cut a step');
  const off = { ...freshModel('vocal'), hpOn: false };
  assert.equal(applyFix(off, 'vocal', 'boomy').model.hpHz, 100, 'low cut off: straight to 100 Hz for a vocal');
  m = applyFix(m, 'vocal', 'sibilant').model;
  assert.deepEqual([m.b4.type, m.b4.hz, m.b4.db], [2, 7000, -2]);
  m = applyFix(m, 'vocal', 'dull').model;
  assert.deepEqual([m.b4.type, m.b4.hz, m.b4.db], [4, 10000, 2], 'dull: high shelf');
  const a = applyFix(freshModel('acoustic'), 'acoustic', 'quacky').model;
  assert.deepEqual([a.b2.hz, a.b2.db], [1200, -2]);
  assert.match(describeTone(a), /−?-2 dB at 1.2 kHz/);
});

test('compression from their loudest singing, and a gentle gate from the hiss', () => {
  let r = applyComp(freshModel('vocal'), 'medium', -12);
  assert.equal(r.model.comp.on, true);
  assert.equal(RATIOS[r.model.comp.ratio], 3);
  // 3:1 and 5 dB off the loudest: threshold = −12 − 5 / (2/3) = −19.5
  assert.equal(r.model.comp.thr, -19.5);
  assert.match(describeTone(r.model), /Compression 3:1 from -19.5 dB/);
  r = applyComp(r.model, 'firm', -12);
  assert.equal(RATIOS[r.model.comp.ratio], 4);
  r = applyComp(r.model, 'off');
  assert.equal(r.model.comp.on, false);
  const g = applyGate(freshModel('vocal'), true, -62);
  assert.deepEqual([g.model.gate.on, g.model.gate.thr, g.model.gate.range, g.model.gate.mode], [true, -54, 12, 3]);
  assert.equal(applyGate(g.model, false).model.gate.on, false);
});

test('bridge: tone is read from the mixer, fixed, undone, saved to the person and loaded next week', async (t) => {
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
  await new Promise((r) => setTimeout(r, 900));
  const cmd = (c) => bridge.handleCommand(c, { local: false });
  const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
  await cmd({ type: 'savePerson', person: { name: 'Sarah Lee', instruments: [{ type: 'vocal' }] } });
  const sarah = bridge.snapshot().setlist.people[0];
  await cmd({ type: 'newSet', title: 'Week 1' });
  await cmd({ type: 'setLineup', slotId: 'vox1', personId: sarah.id }); // ch 3
  await cmd({ type: 'toneRead', slotId: 'vox1' });
  let T = bridge.snapshot().setlist.tone.vox1;
  assert.match(T.summary, /Low cut off/, 'read what the mixer has');
  const sends = bridge.snapshot().setlist.toneFixes.vocal.map((f) => f.id);
  assert.ok(sends.includes('muddy') && sends.includes('sibilant'));

  await cmd({ type: 'toneFix', slotId: 'vox1', fix: 'muddy' });
  await cmd({ type: 'toneFix', slotId: 'vox1', fix: 'muddy' });
  await cmd({ type: 'toneComp', slotId: 'vox1', preset: 'medium', loudDb: -12 });
  await wait();
  assert.ok(Math.abs(sim.state.get('/ch/03/eq/1/g').value - (-4 + 15) / 30) < 1e-6, 'the mixer has −4 dB');
  assert.equal(sim.state.get('/ch/03/dyn/on').value, 1);
  assert.equal(sim.state.get('/ch/03/mix/01/level').value, 0, 'in-ear sends untouched');
  T = bridge.snapshot().setlist.tone.vox1;
  assert.match(T.summary, /-4 dB at 300 Hz.*Compression 3:1/);
  await cmd({ type: 'toneUndo', slotId: 'vox1' });
  await wait();
  assert.equal(sim.state.get('/ch/03/dyn/on').value, 0, 'undo took the compressor off again');
  await cmd({ type: 'toneComp', slotId: 'vox1', preset: 'medium', loudDb: -12 });
  await cmd({ type: 'toneSave', slotId: 'vox1' });
  assert.ok(bridge.snapshot().setlist.tone.vox1.saved, 'saved to Sarah');

  // Next week Sarah is on channel 9; channels are confirmed and her tone follows her.
  await cmd({ type: 'newSet', title: 'Week 2' });
  await cmd({ type: 'setLineup', slotId: 'vox1', personId: sarah.id });
  await cmd({ type: 'setSetChannel', slotId: 'vox1', left: '9', right: '' });
  await cmd({ type: 'channelsDone', done: true });
  await wait(400);
  assert.ok(Math.abs(sim.state.get('/ch/09/eq/1/g').value - (-4 + 15) / 30) < 1e-6, "Sarah's EQ on ch 9");
  assert.equal(sim.state.get('/ch/09/dyn/on').value, 1, "and her compressor");
});
