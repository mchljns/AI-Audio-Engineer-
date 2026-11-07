// End-to-end against the simulated XR18 over real UDP.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';
import { paths } from '../src/xair/addresses.js';
import { dbToFloat } from '../src/xair/faderLaw.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(50);
  }
  return false;
}

test('bridge against simulator', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'));
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1, dataDir, keepAwake: false,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });

  await t.test('connects, syncs names, sees signal', async () => {
    assert.ok(await until(() => bridge.state.strips['15'].name === 'Click'), 'names synced');
    assert.ok(await until(() => bridge.state.hasSignal('1')), 'meters flowing');
  });

  await t.test('inventory classifies the layout', async () => {
    await wait(1500); // let signal memory fill
    const inv = bridge.snapshot().inventory;
    const byId = Object.fromEntries(inv.rows.map((r) => [r.id, r]));
    assert.equal(byId['1'].role, 'pastor');
    assert.equal(byId['15'].role, 'click');
    assert.ok(byId['15'].locked);
    assert.equal(byId['4'].status, 'silent');
    assert.equal(byId['12'].status, 'unlabeled-signal');
    assert.equal(byId['13'].status, 'unused');
    assert.equal(byId.aux.role, 'walkin');
  });

  await t.test('click guard undoes another app routing click to the house', async () => {
    sim.externalChange(paths.lr('15'), { type: 'i', value: 1 });
    assert.ok(await until(() => sim.get(paths.lr('15')) === 0), 'LR assign removed on the mixer');
    assert.ok(bridge.alerts.some((a) => a.source === 'click-guard'));
  });

  await t.test('click guard zeroes FX sends on guide', async () => {
    sim.externalChange(paths.send('16', 8), { type: 'f', value: 0.5 });
    assert.ok(await until(() => sim.get(paths.send('16', 8)) === 0));
  });

  await t.test('UI cannot assign click to main', async () => {
    bridge.handleCommand({ type: 'setLr', id: '15', lr: true });
    await wait(200);
    assert.equal(sim.get(paths.lr('15')), 0);
  });

  await t.test('confirmed role locks a renamed-unknown channel', async () => {
    sim.externalChange(paths.name('14'), { type: 's', value: 'Metro2x' });
    sim.externalChange(paths.lr('14'), { type: 'i', value: 1 });
    await until(() => bridge.state.strips['14'].name === 'Metro2x');
    // "Metro2x" normalises to "metro 2 x" -> click by name; guard should pull it.
    assert.ok(await until(() => sim.get(paths.lr('14')) === 0));
  });

  await t.test('user role confirmation persists and is tied to the name', async () => {
    bridge.handleCommand({ type: 'setRole', id: '12', role: 'room' });
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'roles.json'), 'utf8'));
    assert.equal(saved['12'].role, 'room');
    assert.equal(bridge.snapshot().inventory.rows.find((r) => r.id === '12').role, 'room');
  });

  await t.test('mute unused mutes only blank, silent, unlocked channels', async () => {
    bridge.handleCommand({ type: 'muteUnused', ids: ['13'] });
    await wait(100);
    assert.equal(sim.get(paths.on('13')), 1, 'refused until channels have settled');
    // Pretend meters have been flowing long enough.
    bridge.state.metersSince = Date.now() - 20000;
    const snap = bridge.snapshot();
    assert.ok(snap.unusedReady);
    assert.deepEqual(snap.unused.map((u) => u.id), ['13']);
    bridge.handleCommand({ type: 'muteUnused', ids: ['13', '4', '12', '15'] });
    assert.ok(await until(() => sim.get(paths.on('13')) === 0));
    assert.equal(sim.get(paths.on('4')), 1, 'named-but-silent Vox 2 left alone');
    assert.equal(sim.get(paths.on('12')), 1, 'channel with signal left alone');
  });

  await t.test('walk-in fades out and mutes, then comes back to its level', async () => {
    bridge.handleCommand({ type: 'setFader', id: 'aux', db: -8 });
    await wait(100);
    bridge.handleCommand({ type: 'walkin', action: 'out', seconds: 0.5 });
    assert.ok(await until(() => sim.get(paths.on('aux')) === 0 && sim.get(paths.fader('aux')) === 0), 'faded and muted');
    bridge.handleCommand({ type: 'walkin', action: 'in', seconds: 0.5 });
    assert.ok(await until(() => sim.get(paths.on('aux')) === 1 && Math.abs(sim.get(paths.fader('aux')) - dbToFloat(-8)) < 0.01), 'restored');
  });

  await t.test('a human moving the fader cancels a fade', async () => {
    bridge.handleCommand({ type: 'walkin', action: 'out', seconds: 3 });
    await wait(300);
    sim.externalChange(paths.fader('aux'), { type: 'f', value: dbToFloat(-2) });
    await wait(300);
    assert.equal(bridge.fades.isFading('aux'), false);
    assert.equal(sim.get(paths.on('aux')), 1, 'not muted');
  });
});
