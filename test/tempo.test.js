import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { TempoDetector } from '../src/tempo.js';
import { Effects, delayMsFor } from '../src/effects.js';
import { FxDesk } from '../src/fxsetup.js';
import { MixerState } from '../src/mixerState.js';
import { RoleStore } from '../src/inventory.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

// The click as the meters see it: a frame every ~50 ms (jittery), some clicks missed.
function hear(bpm, { miss = 0.1, eighths = false, hint = null, source = 'click', seconds = 14 } = {}) {
  const d = new TempoDetector();
  const beat = 60000 / bpm / (eighths ? 2 : 1);
  let t = 0;
  let next = 300;
  let r = null;
  while (t < seconds * 1000) {
    t += 45 + Math.random() * 10;
    let level = -85;
    if (t >= next) {
      if (Math.random() > miss) level = -12;
      next += beat;
    }
    r = d.feed({ [source]: [level] }, t, hint);
  }
  return r;
}

test('live tempo: within 1 BPM (usually 0.3) from 66 to 150 BPM, despite meter timing and missed clicks', () => {
  for (const bpm of [66, 72, 88, 104, 120, 136, 150]) {
    const r = hear(bpm) ?? hear(bpm); // a rare run hasn't settled yet: listen again, as the app keeps doing
    assert.ok(r && Math.abs(r.bpm - bpm) <= 1, `${bpm} → ${r?.bpm}`);
    assert.equal(r.source, 'click');
  }
  assert.equal(Math.round(hear(70, { eighths: true, hint: 70 }).bpm), 70, 'eighth-note click folded by the known tempo');
  assert.equal(Math.round(hear(96, { source: 'track' }).bpm), 96, 'from the tracks');
});

test('live tempo: nothing from talking, free time or random strumming', () => {
  const d = new TempoDetector();
  let r = null;
  for (let t = 0; t < 14000; t += 50) r = d.feed({ band: [Math.random() < 0.15 ? -15 : -40 - Math.random() * 20] }, t);
  assert.equal(r, null);
  assert.equal(hear(100, { seconds: 3 }), null, 'needs a few seconds of beats');
});

test('delay time: set from the live tempo once the app runs the delay; small wobbles ignored', async () => {
  const state = new MixerState();
  const sent = [];
  const client = new EventEmitter();
  client.setFloat = (a, v) => sent.push([a, v]);
  client.setInt = (a, v) => sent.push([a, v]);
  client.query = () => {};
  const fx = new Effects({ state, client, roleStore: new RoleStore(null), settings: { delayNote: 'dotted8', delayNoteChosen: true } });
  fx.desk = new FxDesk({ client });
  fx.setSong({ delay: true, lead: [], bpm: 70 });
  fx.tick({ mode: 'worship' });
  assert.equal(sent.filter(([a]) => a === '/fx/2/par/02').length, 0, 'nothing until the delay is confirmed');
  fx.settings.fxConf = { reverb: null, delay: { fx: 2, attempt: 0 } };
  fx.setLive({ bpm: 112, source: 'click', label: 'the click' });
  fx.tick({ mode: 'worship' });
  const ms = delayMsFor(112, 'dotted8');
  assert.equal(ms, 402);
  const time = sent.filter(([a]) => a === '/fx/2/par/02').at(-1);
  assert.ok(time && Math.abs(time[1] - Math.log(ms) / Math.log(3000)) < 1e-9, 'Time (parameter 2) set to 402 ms');
  assert.ok(Math.abs(sent.filter(([a]) => a === '/fx/2/par/10').at(-1)[1] - 21 / 99) < 1e-9, 'feedback 22% for a dotted-1/8 throw');
  const n = sent.length;
  fx.setLive({ bpm: 112.6, source: 'click', label: 'the click' });
  fx.tick({ mode: 'worship' });
  assert.equal(sent.length, n, 'a 0.5% wobble is ignored');
  fx.setSong({ delay: true, lead: ['3'], bpm: 70 });
  assert.match(fx.describe({ 3: 'Sarah' }).join(' '), /Light delay on Sarah \(402 ms at 113 BPM, live from the click\)/);
});

test("bridge: hears the simulator's 120 BPM click and remembers it as the song's tempo", async (t) => {
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
  await new Promise((r) => setTimeout(r, 900));
  await cmd({ type: 'newSet', title: 'Sunday' });
  await cmd({ type: 'addSong', title: 'Holy Forever' });
  await cmd({ type: 'playSong', index: 0 });
  await cmd({ type: 'setSongDelay', index: 0, delay: true });
  for (let i = 0; i < 70 && !(bridge.snapshot().setlist.current.songs[0].bpm > 0); i++) await new Promise((r) => setTimeout(r, 500));
  const snap = bridge.snapshot();
  assert.ok(snap.tempo && Math.abs(snap.tempo.bpm - 120) <= 1, `heard ${snap.tempo?.bpm}`);
  assert.equal(snap.tempo.source, 'click');
  assert.ok(Math.abs(snap.setlist.current.songs[0].bpm - 120) <= 1, 'remembered for the song');
  assert.ok(Math.abs(snap.effects.delayMs - 125) <= 2, `auto: a 1/16 at 120 BPM: ${snap.effects.delayMs}`);
});
