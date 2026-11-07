import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';
import { floatToDb } from '../src/xair/faderLaw.js';

async function rig(t) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'));
  const bridge = await new Bridge({ mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1, dataDir, keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await new Promise((r) => setTimeout(r, 900));
  return { sim, bridge, dataDir, cmd: (c) => bridge.handleCommand(c, { local: false }), wait: (ms) => new Promise((r) => setTimeout(r, ms)) };
}

test('hands off: every fader goes back where people set it, nothing automatic runs, and it survives a restart', async (t) => {
  const { sim, bridge, cmd, wait } = await rig(t);
  await wait(3000); // the auto-mix has been balancing the speech mics
  const moved = [...bridge.automix.ch].filter(([id, c]) => /^\d+$/.test(id) && Math.abs(c.offsetDb) > 1).map(([id]) => id);
  assert.ok(moved.length > 0, 'the auto-mix had moved something');
  await cmd({ type: 'handsOff', on: true });
  await wait(1500);
  for (const id of moved) {
    const c = bridge.automix.ch.get(id);
    assert.ok(Math.abs(floatToDb(sim.state.get(`/ch/${id.padStart(2, '0')}/mix/fader`).value) - floatToDb(c.home)) < 0.3, `ch ${id} back at its level`);
    assert.equal(c.offsetDb, 0);
  }
  assert.equal(bridge.snapshot().handsOff, true);
  assert.ok(bridge.alerts?.length !== 0);
  const settings = JSON.parse(fs.readFileSync(bridge.settingsFile ?? path.join(bridge.config.dataDir, 'settings.json'), 'utf8'));
  assert.equal(settings.handsOff, true, 'stays paused after a restart');
  await cmd({ type: 'handsOff', on: false });
  await wait(2000);
  assert.equal(bridge.snapshot().handsOff, false);
  assert.ok([...bridge.automix.ch.values()].some((c) => Math.abs(c.offsetDb) > 0.5), 'mixing again');
});

test('get ready: steps are kept per set for every iPad; a level set marks that person done', async (t) => {
  const { bridge, cmd, wait } = await rig(t);
  await cmd({ type: 'savePerson', person: { name: 'Sarah', instruments: [{ type: 'vocal' }] } });
  const sarah = bridge.snapshot().setlist.people[0];
  await cmd({ type: 'newSet', title: 'Sunday' });
  await cmd({ type: 'setLineup', slotId: 'vox1', personId: sarah.id });
  await cmd({ type: 'readyMark', step: 'set' });
  await cmd({ type: 'readyMark', step: 'roles' });
  await cmd({ type: 'readyMark', step: 'nonsense' });
  await cmd({ type: 'toneGain', slotId: 'vox1', loudDb: -24 });
  await wait(300);
  const ready = bridge.snapshot().setlist.current.ready;
  assert.deepEqual(ready, { gain: { vox1: true }, set: true, roles: true });
  await cmd({ type: 'newSet', title: 'Next week' });
  assert.equal(bridge.snapshot().setlist.current.ready, undefined, 'a new week starts fresh');
});

test('tone before / after: hear the old sound and the new one; leaving keeps the new one', async (t) => {
  const { sim, bridge, cmd, wait } = await rig(t);
  await cmd({ type: 'savePerson', person: { name: 'Sarah', instruments: [{ type: 'vocal' }] } });
  const sarah = bridge.snapshot().setlist.people[0];
  await cmd({ type: 'newSet', title: 'Sunday' });
  await cmd({ type: 'setLineup', slotId: 'vox1', personId: sarah.id });
  await cmd({ type: 'toneFix', slotId: 'vox1', fix: 'muddy' });
  await wait(300);
  const g = () => sim.state.get('/ch/03/eq/1/g').value;
  assert.ok(Math.abs(g() - 13 / 30) < 1e-6, 'after: −2 dB');
  assert.equal(bridge.snapshot().setlist.tone.vox1.ab, 'after');
  await cmd({ type: 'toneAB', slotId: 'vox1', which: 'before' });
  await wait(300);
  assert.ok(Math.abs(g() - 0.5) < 1e-6, 'before: flat');
  assert.equal(bridge.snapshot().setlist.tone.vox1.ab, 'before');
  await cmd({ type: 'toneFix', slotId: 'vox1', fix: 'muddy' }); // another tap builds on the change
  await wait(300);
  assert.ok(Math.abs(g() - 11 / 30) < 1e-6, '−4 dB: built on the after, not the before');
  await cmd({ type: 'toneUndo', slotId: 'vox1' });
  await wait(300);
  assert.ok(Math.abs(g() - 13 / 30) < 1e-6, 'undo goes back one step');
  assert.equal(bridge.snapshot().setlist.tone.vox1.ab, null);
});
