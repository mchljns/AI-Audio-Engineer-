import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseHardwarePorts, kindOf, pathTo, chooseMixer } from '../src/netpath.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}

const PORTS = `
Hardware Port: Wi-Fi
Device: en0
Ethernet Address: aa:bb:cc:dd:ee:ff

Hardware Port: USB 10/100/1000 LAN
Device: en7
Ethernet Address: 11:22:33:44:55:66

Hardware Port: iPhone USB
Device: en8

Hardware Port: Thunderbolt Bridge
Device: bridge0
`;

test('macOS port names tell Wi-Fi from cable', () => {
  const map = parseHardwarePorts(PORTS);
  assert.deepEqual(map, { en0: 'Wi-Fi', en7: 'USB 10/100/1000 LAN', en8: 'iPhone USB', bridge0: 'Thunderbolt Bridge' });
  assert.equal(kindOf('en0', map), 'wifi');
  assert.equal(kindOf('en7', map), 'cable');
  assert.equal(kindOf('en8', map), 'phone');
  assert.equal(kindOf('bridge0', map), 'other');
  assert.equal(kindOf('wlan0'), 'wifi');
  assert.equal(kindOf('eth0'), 'cable');
});

test('the connection that reaches a mixer address is found by network', () => {
  const interfaces = {
    en0: [{ family: 'IPv4', address: '192.168.1.50', netmask: '255.255.255.0', internal: false }],
    en7: [{ family: 'IPv4', address: '192.168.2.20', netmask: '255.255.255.0', internal: false }],
  };
  const portMap = parseHardwarePorts(PORTS);
  assert.equal(pathTo('192.168.1.1', { interfaces, portMap }).kind, 'wifi');
  assert.equal(pathTo('192.168.2.10', { interfaces, portMap }).kind, 'cable');
  assert.equal(pathTo('10.0.0.5', { interfaces, portMap }).kind, 'other');
});

test('preference picks the right mixer address and falls back instead of dropping', () => {
  const wifi = { host: '192.168.1.1', name: 'XR18', path: { kind: 'wifi' } };
  const cable = { host: '192.168.2.10', name: 'XR18', path: { kind: 'cable' } };
  assert.equal(chooseMixer([wifi, cable], 'auto').pick, cable, 'automatic prefers the steadier cable');
  assert.equal(chooseMixer([wifi, cable], 'wifi').pick, wifi);
  assert.equal(chooseMixer([wifi, cable], 'cable').pick, cable);
  const r = chooseMixer([wifi], 'cable');
  assert.equal(r.pick, wifi, 'no cable: keeps the mixer over Wi-Fi');
  assert.equal(r.preferenceMet, false);
  assert.equal(chooseMixer([], 'auto').pick, null);
});

test('venues, connection preference and the setup checklist', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const bridge = new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null,
  });
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await bridge.start();
  await until(() => bridge.status.connected);

  await t.test('only the Mac can change connection and venues', () => {
    bridge.handleCommand({ type: 'saveVenue', name: 'School', notes: 'Mixer Wi-Fi only' }, { local: false });
    assert.equal(bridge.snapshot({ local: true }).mac.venues.length, 0);
  });

  await t.test('saving and choosing venues sets the connection', async () => {
    bridge.handleCommand({ type: 'setConnection', mode: 'wifi' });
    bridge.handleCommand({ type: 'saveVenue', name: 'School', notes: 'Use the mixer Wi-Fi.' });
    bridge.handleCommand({ type: 'setConnection', mode: 'cable' });
    bridge.handleCommand({ type: 'saveVenue', name: 'Camp', notes: 'Cable to the rack.', connection: 'cable' });
    let mac = bridge.snapshot({ local: true }).mac;
    // School was the chosen venue when the connection changed to cable, so it followed.
    assert.deepEqual(mac.venues.map((v) => [v.name, v.connection]), [['School', 'cable'], ['Camp', 'cable']]);
    bridge.handleCommand({ type: 'selectVenue', index: 0 });
    bridge.handleCommand({ type: 'setConnection', mode: 'wifi' });
    mac = bridge.snapshot({ local: true }).mac;
    assert.equal(mac.venue, 0);
    assert.equal(mac.connection.mode, 'wifi');
    assert.equal(mac.venues[0].connection, 'wifi', "changing the connection updates the chosen venue");
    assert.equal(bridge.snapshot().checklist.venue.notes, 'Use the mixer Wi-Fi.');
    bridge.handleCommand({ type: 'deleteVenue', index: 1 });
    assert.equal(bridge.snapshot({ local: true }).mac.venues.length, 1);
    bridge.handleCommand({ type: 'setConnection', mode: 'nonsense' });
    assert.equal(bridge.snapshot({ local: true }).mac.connection.mode, 'wifi');
  });

  await t.test('checklist: automatic items, ticks from any device, fresh each day', async () => {
    const c = bridge.snapshot().checklist;
    assert.ok(c.auto.find((i) => i.id === 'auto-mixer').ok, 'mixer connected is ticked automatically');
    bridge.handleCommand({ type: 'checkItem', id: 'bluetooth', done: true }, { local: false });
    bridge.handleCommand({ type: 'checkItem', id: 'not-an-item', done: true }, { local: false });
    assert.equal(bridge.snapshot().checklist.manual.find((i) => i.id === 'bluetooth').done, true);
    bridge.settings.checklist.date = '2000-01-01'; // pretend it's next Sunday
    assert.equal(bridge.snapshot().checklist.manual.find((i) => i.id === 'bluetooth').done, false, 'reset for a new day');
  });
});
