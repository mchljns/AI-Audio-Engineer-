// Tests for the QA fixes: sticky locks, protected buses, PIN, discovery, web server safety.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';
import { paths } from '../src/xair/addresses.js';
import { broadcastAddresses } from '../src/xair/client.js';
import { isProtectedBusName } from '../src/clickGuard.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}
async function rig(t, extra = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-'));
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1, dataDir,
    keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null, ...extra,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await until(() => bridge.state.strips['15'].name === 'Click' && bridge.state.buses[6].name === 'Stream');
  await wait(300);
  return { sim, bridge, dataDir };
}

test('broadcast addresses cover every network', () => {
  const list = broadcastAddresses({
    en0: [{ family: 'IPv4', address: '192.168.1.20', netmask: '255.255.255.0', internal: false }],
    en1: [{ family: 'IPv4', address: '10.0.5.9', netmask: '255.255.0.0', internal: false }],
    lo0: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
  });
  assert.deepEqual(list.sort(), ['10.0.255.255', '192.168.1.255', '255.255.255.255']);
});

test('protected bus names', () => {
  for (const n of ['Stream', 'Livestream', 'Live Feed', 'Rec', 'Lobby', 'Pastor Wedge', 'FOH Fill']) assert.ok(isProtectedBusName(n), n);
  for (const n of ['Keys IEM', 'Gtr IEM', 'BGV IEM', 'Drum Mix', '']) assert.ok(!isProtectedBusName(n), n);
});

test('click guard: protected buses and sticky locks', async (t) => {
  const { sim, bridge, dataDir } = await rig(t);

  await t.test('in-ear sends are left alone, livestream send is zeroed', async () => {
    assert.ok(sim.get(paths.send('15', 1)) > 0, 'click still in keys in-ears');
    sim.externalChange(paths.send('15', 6), { type: 'f', value: 0.5 });
    assert.ok(await until(() => sim.get(paths.send('15', 6)) === 0), 'stream send removed');
    assert.ok(sim.get(paths.send('15', 1)) > 0, 'in-ear send untouched');
    assert.ok(bridge.alerts.some((a) => /Stream/.test(a.message)));
  });

  await t.test('renaming the click channel keeps it locked and warns', async () => {
    sim.externalChange(paths.name('15'), { type: 's', value: 'Ch 15' });
    await until(() => bridge.state.strips['15'].name === 'Ch 15');
    sim.externalChange(paths.lr('15'), { type: 'i', value: 1 });
    assert.ok(await until(() => sim.get(paths.lr('15')) === 0), 'still pulled from the house');
    assert.ok(bridge.alerts.some((a) => /was the Click channel/.test(a.message)), 'rename warning');
    const row = bridge.snapshot().inventory.rows.find((r) => r.id === '15');
    assert.equal(row.locked, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'locks.json'), 'utf8'));
    assert.equal(saved['15'].role, 'click');
  });

  await t.test('only a person choosing a new role releases the lock', async () => {
    bridge.handleCommand({ type: 'setRole', id: '15', role: 'vocal' });
    bridge.handleCommand({ type: 'setLr', id: '15', lr: true });
    assert.ok(await until(() => sim.get(paths.lr('15')) === 1), 'LR allowed after release');
    await wait(300);
    assert.equal(sim.get(paths.lr('15')), 1, 'guard did not pull it back');
  });

  await t.test('unknown role names are rejected', () => {
    bridge.handleCommand({ type: 'setRole', id: '3', role: 'banana' });
    assert.equal(bridge.roleStore.get('3', bridge.state.strips['3'].name), null);
  });
});

test('PIN protects the mixer from other devices', async (t) => {
  const { bridge } = await rig(t, { pin: '4821', trustLocalhost: false });
  await until(() => bridge.boundPort);
  const base = `127.0.0.1:${bridge.boundPort}`;

  await t.test('state API needs the PIN', async () => {
    assert.equal((await fetch(`http://${base}/api/state`)).status, 401);
    const ok = await fetch(`http://${base}/api/state?pin=4821`);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).pin, undefined, 'PIN not revealed to other devices');
  });

  await t.test('websocket: no state or control until the PIN is right', async () => {
    const ws = new WebSocket(`ws://${base}/ws`);
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(d)));
    await new Promise((r) => ws.on('open', r));
    await wait(300);
    assert.equal(msgs[0].type, 'auth-required');
    assert.ok(!msgs.some((m) => m.type === 'state'), 'no state before PIN');
    ws.send(JSON.stringify({ type: 'setOn', id: '1', on: false }));
    await wait(200);
    assert.equal(bridge.state.strips['1'].on, true, 'command ignored before PIN');
    ws.send(JSON.stringify({ type: 'auth', pin: '0000' }));
    await until(() => msgs.some((m) => m.type === 'auth-failed'));
    ws.send(JSON.stringify({ type: 'auth', pin: '4821' }));
    assert.ok(await until(() => msgs.some((m) => m.type === 'state')), 'state after PIN');
    ws.close();
  });

  await t.test('too many wrong PINs locks that device out for a minute', async () => {
    for (let i = 0; i < 5; i++) await fetch(`http://${base}/api/state?pin=9999`);
    const r = await fetch(`http://${base}/api/state?pin=4821`);
    assert.equal(r.status, 401, 'right PIN refused during lockout');
  });
});

test('web server refuses paths outside the app', async (t) => {
  const { bridge } = await rig(t);
  await until(() => bridge.boundPort);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/%E0%A4%A', '/src/bridge.js']) {
    const r = await fetch(`http://127.0.0.1:${bridge.boundPort}${p}`);
    assert.equal(r.status, 404, p);
  }
  assert.equal((await fetch(`http://127.0.0.1:${bridge.boundPort}/`)).status, 200);
});

test('mono PA: channels panned off-centre are flagged', async (t) => {
  const { sim, bridge } = await rig(t);
  await until(() => bridge.state.strips['7'].pan === 0);
  sim.externalChange(paths.pan('6'), { type: 'f', value: 0.1 });
  await until(() => bridge.state.strips['6'].pan === 0.1);
  const rows = Object.fromEntries(bridge.snapshot().inventory.rows.map((r) => [r.id, r]));
  assert.equal(rows['7'].offCenter, false, 'stereo pair Keys L is fine: both mains are summed');
  assert.equal(rows['8'].offCenter, false, 'stereo pair Keys R is fine');
  assert.equal(rows['6'].offCenter, true, 'single channel panned hard is flagged');
  assert.equal(rows['1'].offCenter, false, 'pastor centred');
  sim.externalChange(paths.pan('6'), { type: 'f', value: 0.5 });
  assert.ok(await until(() => !bridge.snapshot().inventory.rows.find((r) => r.id === '6').offCenter));
});
