// Regression tests for the independent review's findings: each one reproduces an attack or failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import path from 'node:path';
import WebSocket from 'ws';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';
import { paths } from '../src/xair/addresses.js';
import { encodeMessage } from '../src/osc.js';
import { classifyBusName } from '../src/clickGuard.js';

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
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false,
    trustLocalhost: true, protectedBuses: null, ...extra,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await until(() => bridge.state.strips['15'].name === 'Click' && bridge.boundPort && bridge.status.connected);
  await wait(300);
  return { sim, bridge, port };
}
function rawHttp(port, text) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.end(text));
    let out = '';
    sock.on('data', (d) => (out += d));
    sock.on('close', () => resolve(out));
    sock.on('error', () => resolve(out));
  });
}

test('bus names: streams and speakers protected, in-ears allowed, unclear names flagged', () => {
  for (const n of ['Recording', 'Streaming', 'LS Mix', 'Online', 'Main', 'Stream', 'Lobby']) assert.equal(classifyBusName(n), 'protected', n);
  for (const n of ['Keys IEM', 'Gtr Mon', 'Drummer', 'Band Mix']) assert.equal(classifyBusName(n), 'monitor', n);
  for (const n of ['', 'Bus 5', 'Aux 3', 'Choir']) assert.equal(classifyBusName(n), 'unknown', n);
});

test('review findings', async (t) => {
  const { sim, bridge, port } = await rig(t);

  await t.test('#2 numeric channel id cannot bypass the main-speaker lock', async () => {
    bridge.handleCommand({ type: 'setLr', id: 15, lr: true });
    await wait(300);
    assert.equal(sim.get(paths.lr('15')), 0);
  });

  await t.test('#4 packets not from the mixer are ignored', async () => {
    sim.externalChange(paths.lr('3'), { type: 'i', value: 1 });
    await until(() => bridge.state.strips['3'].lr === true);
    const sock = dgram.createSocket('udp4');
    await new Promise((r) => sock.bind(0, r));
    // Spoof a "mixer" message from a different port pretending LR is off.
    const addr = bridge.client.socket.address();
    sock.send(encodeMessage(paths.lr('3'), [{ type: 'i', value: 0 }]), addr.port, '127.0.0.1');
    await wait(300);
    sock.close();
    assert.equal(bridge.state.strips['3'].lr, true, 'spoofed packet had no effect');
  });

  await t.test('#8 bad meter packets do not crash the bridge', async () => {
    const bad = Buffer.alloc(8);
    bad.writeInt32LE(-1, 0);
    bridge.client.emit('message', { address: '/meters/1', args: [{ type: 'b', value: bad }] });
    bridge.client.emit('message', { address: '/meters/1', args: [{ type: 'i', value: 5 }] });
    bridge.client.emit('message', { address: paths.fader('2'), args: [{ type: 's', value: 'loud' }] });
    assert.ok(Number.isFinite(bridge.state.strips['2'].fader));
  });

  await t.test('#9 fader commands without a real number are refused; odd ids are ignored', async () => {
    // Ch 13 is an idle channel the auto-mix doesn't touch.
    const before = sim.get(paths.fader('13'));
    bridge.handleCommand({ type: 'setFader', id: '13' });
    bridge.handleCommand({ type: 'setFader', id: '13', value: 'NaN' });
    bridge.handleCommand({ type: 'setFader', id: '13', db: null });
    await wait(200);
    assert.equal(sim.get(paths.fader('13')), before);
    bridge.handleCommand({ type: 'setOn', id: '__proto__', on: false });
    assert.equal(({}).on, undefined, 'Object.prototype untouched');
    bridge.handleCommand({ type: 'setDcaFader', n: '__proto__', value: 0 });
    bridge.handleCommand(null);
    bridge.handleCommand('x');
  });

  await t.test('#6 malformed web requests do not crash the server', async () => {
    await rawHttp(bridge.boundPort, 'GET //[ HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await rawHttp(bridge.boundPort, 'GARBAGE\r\n\r\n');
    assert.equal((await fetch(`http://127.0.0.1:${bridge.boundPort}/healthz`)).status, 200, 'still serving');
  });

  await t.test('#7 an oversized WebSocket message does not crash the bridge', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.boundPort}/ws`);
    await new Promise((r) => ws.on('open', r));
    ws.on('error', () => {});
    ws.send('x'.repeat(64 * 1024));
    await wait(300);
    assert.equal((await fetch(`http://127.0.0.1:${bridge.boundPort}/healthz`)).status, 200, 'still serving');
  });

  await t.test('#10 another website open on the Mac cannot connect', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${bridge.boundPort}/ws`, { headers: { Origin: 'https://evil.example' } });
    const outcome = await new Promise((r) => {
      ws.on('open', () => r('open'));
      ws.on('error', () => r('refused'));
      ws.on('unexpected-response', () => r('refused'));
    });
    assert.equal(outcome, 'refused');
    const raw = await rawHttp(bridge.boundPort, 'GET /api/state HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n');
    assert.match(raw, /^HTTP\/1\.1 403/, 'DNS-rebinding style Host refused');
  });

  await t.test('#3 a renamed click channel can be released by a person', async () => {
    sim.externalChange(paths.name('16'), { type: 's', value: 'Vox 4' });
    await until(() => bridge.state.strips['16'].name === 'Vox 4');
    assert.ok(bridge.snapshot().inventory.rows.find((r) => r.id === '16').locked, 'still locked after rename');
    bridge.handleCommand({ type: 'releaseLock', id: '16' });
    assert.ok(!bridge.snapshot().inventory.rows.find((r) => r.id === '16').locked, 'released');
  });

  await t.test('click on an unnamed aux is left alone: auxes are the band\'s mixes', async () => {
    sim.externalChange(paths.busName(3), { type: 's', value: '' });
    sim.externalChange(paths.send('15', 3), { type: 'f', value: 0.5 });
    await wait(600);
    assert.equal(sim.get(paths.send('15', 3)), 0.5, 'not zeroed');
  });

  await t.test('#17 nothing is sent while the mixer is offline', async () => {
    bridge.status.connected = false;
    bridge.handleCommand({ type: 'setOn', id: '1', on: false });
    bridge.status.connected = true;
    await wait(200);
    assert.equal(sim.get(paths.on('1')), 1);
  });
});
