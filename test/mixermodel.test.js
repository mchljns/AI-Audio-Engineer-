// Mixer model setting: the XR18 stays the default; the X32 profile switches every address.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as A from '../src/xair/addresses.js';
import { blockedWrite } from '../src/xair/client.js';
import { toneAddress } from '../src/tone.js';
import { fxReturnFader, fxSendBus } from '../src/effects.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}

test('XR18 is the default and its addresses are unchanged', () => {
  A.useMixerModel('xr18');
  assert.equal(A.MIXER_MODEL, 'xr18');
  assert.equal(A.OSC_PORT, 10024);
  assert.equal(A.STRIP_IDS.length, 17);
  assert.deepEqual(A.AUX_BUSES, [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(A.fxSendBuses, [7, 8, 9, 10]);
  assert.equal(A.DCA_COUNT, 4);
  assert.equal(A.paths.lr('1'), '/ch/01/mix/lr');
  assert.equal(A.paths.fader('aux'), '/rtn/aux/mix/fader');
  assert.equal(A.paths.busName(6), '/bus/6/config/name');
  assert.deepEqual(A.parseAddress('/rtn/aux/mix/fader'), { id: 'aux', field: 'fader' });
  assert.deepEqual(A.parseAddress('/bus/3/config/name'), { bus: 3, field: 'name' });
  assert.equal(A.parseAddress('/ch/17/mix/fader'), null);
  assert.equal(toneAddress('3', 'headamp'), '/headamp/03/gain');
  assert.equal(fxReturnFader(2), '/rtn/2/mix/fader');
  assert.equal(fxSendBus(1), 7);
  const m = A.metersToStrips(Array.from({ length: 40 }, (_, i) => -i));
  assert.equal(m['16'], -15);
  assert.equal(m.aux, -16);
  // In-ear sends blocked, FX sends allowed.
  assert.equal(blockedWrite('/ch/01/mix/03/level'), true);
  assert.equal(blockedWrite('/ch/01/mix/07/level'), false);
  assert.equal(blockedWrite('/headamp/01/phantom'), true);
});

test('X32 profile: port, 32 channels, 8 DCAs and its own addresses', () => {
  try {
    A.useMixerModel('x32');
    assert.equal(A.MIXER_MODEL, 'x32');
    assert.equal(A.OSC_PORT, 10023);
    assert.equal(A.STRIP_IDS.length, 33);
    assert.equal(A.DCA_COUNT, 8);
    assert.deepEqual(A.AUX_BUSES, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.deepEqual(A.fxSendBuses, [13, 14, 15, 16]);
    assert.equal(A.paths.lr('1'), '/ch/01/mix/st');
    assert.equal(A.paths.fader('aux'), '/auxin/07/mix/fader');
    assert.equal(A.paths.busName(5), '/bus/05/config/name');
    assert.deepEqual(A.parseAddress('/ch/32/mix/st'), { id: '32', field: 'lr' });
    assert.deepEqual(A.parseAddress('/auxin/07/mix/on'), { id: 'aux', field: 'on' });
    assert.deepEqual(A.parseAddress('/bus/05/config/name'), { bus: 5, field: 'name' });
    assert.equal(A.parseAddress('/bus/5/config/name'), null);
    assert.equal(A.parseAddress('/ch/01/mix/lr'), null);
    assert.equal(toneAddress('1', 'headamp'), '/headamp/000/gain');
    assert.equal(toneAddress('32', 'headamp'), '/headamp/031/gain');
    assert.equal(fxReturnFader(1), '/fxrtn/01/mix/fader');
    assert.equal(fxReturnFader(3), '/fxrtn/05/mix/fader');
    assert.equal(fxSendBus(2), 14);
    const m = A.metersToStrips(Array.from({ length: 70 }, (_, i) => -i));
    assert.equal(m['32'], -31);
    assert.equal(m.aux, -38);
    // In-ear buses 1–12 blocked from every source; FX buses 13–16 allowed; matrices, phantom and buses blocked.
    assert.equal(blockedWrite('/ch/20/mix/12/level'), true);
    assert.equal(blockedWrite('/auxin/07/mix/01/level'), true);
    assert.equal(blockedWrite('/fxrtn/01/mix/04/level'), true);
    assert.equal(blockedWrite('/ch/20/mix/13/level'), false);
    assert.equal(blockedWrite('/mtx/01/mix/fader'), true);
    assert.equal(blockedWrite('/bus/13/mix/fader'), true);
    assert.equal(blockedWrite('/headamp/000/phantom'), true);
    assert.equal(blockedWrite('/headamp/000/gain'), false);
  } finally {
    A.useMixerModel('xr18');
  }
});

test('an unknown model falls back to the XR18', () => {
  A.useMixerModel('m32');
  assert.equal(A.MIXER_MODEL, 'xr18');
});

async function rig(t, { model, settings } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-model-'));
  if (settings) fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings));
  let restarted = 0;
  // The bridge picks the model when it's created; the simulator then serves that model too.
  const bridge = new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1, dataDir,
    keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null, mixerModel: model ?? null,
    updateExit: () => restarted++,
  });
  const sim = await new XR18Simulator({ port }).start();
  await bridge.start();
  t.after(() => {
    bridge.stop();
    sim.stop();
    A.useMixerModel('xr18');
  });
  return { bridge, sim, dataDir, restarts: () => restarted };
}

test('a bridge set to the X32 connects to it and reads 32 channels', async (t) => {
  const { bridge } = await rig(t, { settings: { mixerModel: 'x32' } });
  assert.ok(await until(() => bridge.status.connected), 'connects');
  assert.ok(await until(() => bridge.state.strips['15'].name === 'Click'), 'reads channel names over X32 addresses');
  assert.equal(Object.keys(bridge.state.strips).length, 33);
  assert.equal(Object.keys(bridge.state.dcas).length, 8);
  const snap = bridge.snapshot ? bridge.snapshot({ local: true }) : null;
  if (snap) {
    assert.equal(snap.mixerModel.id, 'x32');
    assert.equal(snap.mixerModel.tested, false);
    assert.equal(snap.mixerModel.feedbackCatcher, false);
  }
  // A fader move goes out on the X32 address and is mirrored back.
  bridge.handleCommand({ type: 'setFader', id: '20', value: 0.5 });
  assert.ok(await until(() => Math.abs(bridge.state.strips['20'].fader - 0.5) < 0.01), 'fader on ch 20');
});

test('changing the model is saved and restarts Mix Assistant; iPads cannot change it', async (t) => {
  const { bridge, dataDir, restarts } = await rig(t);
  assert.equal(A.MIXER_MODEL, 'xr18');
  bridge.handleCommand({ type: 'setMixerModel', model: 'x32' }, { local: false });
  await wait(1700);
  assert.equal(restarts(), 0, 'an iPad cannot switch mixers');
  bridge.handleCommand({ type: 'setMixerModel', model: 'nonsense' });
  bridge.handleCommand({ type: 'setMixerModel', model: 'x32' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8')).mixerModel, 'x32');
  assert.ok(await until(() => restarts() === 1, 3000), 'restarts to apply it');
});

test('config.json mixerModel wins over the in-app setting', async (t) => {
  const { bridge, restarts } = await rig(t, { model: 'xr18', settings: { mixerModel: 'x32' } });
  assert.equal(A.MIXER_MODEL, 'xr18');
  bridge.handleCommand({ type: 'setMixerModel', model: 'x32' });
  await wait(1700);
  assert.equal(restarts(), 0);
});
