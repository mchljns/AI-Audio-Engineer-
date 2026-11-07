// A pretend XR18 for development and testing without the real mixer.
// Speaks the same OSC over UDP, answers queries, accepts changes, pushes
// changes to /xremote subscribers and streams /meters/1.
//
//   node src/simulator/xr18-sim.js            # normal
//   node src/simulator/xr18-sim.js --chaos    # also misbehaves, to exercise the click guard

import dgram from 'node:dgram';
import { pathToFileURL } from 'node:url';
import { encodeMessage, decodeMessage } from '../osc.js';
import { OSC_PORT, STRIP_IDS, DCA_COUNT, AUX_BUSES, paths, fxSendBuses, encodeMeterBlob } from '../xair/addresses.js';
import { dbToFloat } from '../xair/faderLaw.js';

const SUB_TTL_MS = 10000;

// The church layout from the plan. Ch 4 is named but silent; ch 12 is unnamed with signal.
const LAYOUT = {
  1: { name: 'Pastor', pattern: 'speech', db: -18 },
  2: { name: 'Announce', pattern: 'speech', db: -20 },
  3: { name: 'Vox 1', pattern: 'sing', db: -16 },
  4: { name: 'Vox 2', pattern: 'silent' },
  5: { name: 'Vox 3', pattern: 'sing', db: -20 },
  6: { name: 'Ac Gtr', pattern: 'steady', db: -18 },
  7: { name: 'Keys L', pattern: 'steady', db: -16 },
  8: { name: 'Keys R', pattern: 'steady', db: -16 },
  9: { name: 'Trk 1', pattern: 'steady', db: -20 },
  10: { name: 'Trk 2', pattern: 'steady', db: -22 },
  11: { name: 'Trk 3', pattern: 'steady', db: -24 },
  12: { name: '', pattern: 'steady', db: -30 },
  15: { name: 'Click', pattern: 'click', db: -12 },
  16: { name: 'Guide', pattern: 'speech', db: -16 },
  aux: { name: 'Spotify', pattern: 'steady', db: -14 },
};

const BUS_NAMES = ['IEM Keys', 'IEM Gtr', 'IEM Vox 1', 'IEM Vox 2', '', ''];

function initialState() {
  const st = new Map();
  for (const id of STRIP_IDS) {
    const l = LAYOUT[id] ?? {};
    const isLocked = id === '15' || id === '16';
    st.set(paths.name(id), { type: 's', value: l.name ?? '' });
    st.set(paths.color(id), { type: 'i', value: 0 });
    st.set(paths.on(id), { type: 'i', value: 1 });
    st.set(paths.fader(id), { type: 'f', value: l.name ? dbToFloat(-5) : 0 });
    st.set(paths.lr(id), { type: 'i', value: isLocked ? 0 : 1 });
    // Stereo keys arrive panned hard left/right, as they often do.
    st.set(paths.pan(id), { type: 'f', value: id === '7' ? 0 : id === '8' ? 1 : 0.5 });
    st.set(paths.dcaGroups(id), { type: 'i', value: 0 });
    st.set(paths.muteGroups(id), { type: 'i', value: 0 });
    for (const b of fxSendBuses) st.set(paths.send(id, b), { type: 'f', value: 0 });
    // Click and guide feed the keys and guitar in-ears (aux 1-2), as they should.
    for (const b of AUX_BUSES) st.set(paths.send(id, b), { type: 'f', value: isLocked && b <= 2 ? dbToFloat(-5) : 0 });
  }
  // Channel processing (low cut, EQ, compressor, gate) for ch 1–16, as a fresh XR18 has it.
  for (let i = 1; i <= 16; i++) {
    const c = `/ch/${String(i).padStart(2, '0')}`;
    const f = (k, v) => st.set(`${c}/${k}`, { type: 'f', value: v });
    const n = (k, v) => st.set(`${c}/${k}`, { type: 'i', value: v });
    n('preamp/hpon', 0);
    f('preamp/hpf', 0.5);
    n('eq/on', 1);
    [0.2, 0.45, 0.65, 0.85].forEach((fr, b) => {
      n(`eq/${b + 1}/type`, 2);
      f(`eq/${b + 1}/f`, fr);
      f(`eq/${b + 1}/g`, 0.5);
      f(`eq/${b + 1}/q`, 0.5);
    });
    for (const [k, v] of [['on', 0], ['mode', 0], ['ratio', 3], ['auto', 0]]) n(`dyn/${k}`, v);
    for (const [k, v] of [['thr', 0.6], ['knee', 0.4], ['mgain', 0], ['attack', 0.1], ['release', 0.5]]) f(`dyn/${k}`, v);
    for (const [k, v] of [['on', 0], ['mode', 3]]) n(`gate/${k}`, v);
    for (const [k, v] of [['thr', 0.3], ['range', 0.3], ['attack', 0], ['hold', 0.5], ['release', 0.5]]) f(`gate/${k}`, v);
  }
  // FX returns 1–4 (reverb on FX1, delay on FX2, as most churches set it).
  for (let n = 1; n <= 4; n++) st.set(`/rtn/${n}/mix/fader`, { type: 'f', value: n <= 2 ? dbToFloat(-5) : 0 });
  BUS_NAMES.forEach((name, i) => st.set(paths.busName(i + 1), { type: 's', value: name }));
  for (let n = 1; n <= DCA_COUNT; n++) {
    st.set(paths.dcaName(n), { type: 's', value: ['Speech', 'Vocals', 'Band', 'Tracks'][n - 1] });
    st.set(paths.dcaFader(n), { type: 'f', value: dbToFloat(0) });
    st.set(paths.dcaOn(n), { type: 'i', value: 1 });
  }
  return st;
}

// A pretend Sunday, on a loop, for practice mode: which channels are making sound in each part.
export const SERVICE = [
  { part: 'walkin', secs: 40, live: ['aux'] },
  { part: 'worship', secs: 70, live: ['3', '5', '6', '7', '8', '9', '10', '11', '15', '16'] },
  { part: 'announcements', secs: 45, live: ['2', '7', '8'], quiet: ['7', '8'] },
  { part: 'sermon', secs: 70, live: ['1'] },
  { part: 'worship', secs: 50, live: ['3', '5', '6', '7', '8', '9', '10', '11', '15', '16'] },
  { part: 'postservice', secs: 30, live: ['aux'] },
];
const SERVICE_TOTAL = SERVICE.reduce((n, p) => n + p.secs, 0) * 1000;

export function servicePart(t) {
  let at = t % SERVICE_TOTAL;
  for (const p of SERVICE) {
    if (at < p.secs * 1000) return p;
    at -= p.secs * 1000;
  }
  return SERVICE[0];
}

function meterLevel(id, t, scenario) {
  const l = LAYOUT[id];
  if (scenario === 'service' && l) {
    const part = servicePart(t);
    if (!part.live.includes(id)) return -85 + Math.random() * 4;
    if (part.quiet?.includes(id)) return l.db - 10 + (Math.random() - 0.5) * 3;
  }
  const noise = -85 + Math.random() * 4;
  if (!l || l.pattern === 'silent') return noise;
  const jitter = (Math.random() - 0.5) * 4;
  switch (l.pattern) {
    case 'speech': // words and pauses
      return Math.sin(t / 380) + Math.sin(t / 900) > 0.2 ? l.db + jitter : noise + 20;
    case 'sing':
      return Math.sin(t / 2500) > -0.6 ? l.db + jitter : noise + 15;
    case 'click': // 120 BPM tick
      return t % 500 < 40 ? l.db : noise;
    default:
      return l.db + jitter;
  }
}

export class XR18Simulator {
  constructor({ port = OSC_PORT, host = '127.0.0.1', chaos = false, log = false, scenario = 'steady' } = {}) {
    this.scenario = scenario;
    this.port = port;
    this.host = host;
    this.chaos = chaos;
    this.log = log;
    this.state = initialState();
    this.remoteSubs = new Map(); // "addr:port" -> expiry
    this.meterSubs = new Map();
    this.forced = new Map(); // tests: channel -> dB, e.g. someone singing into a pack
    this.timers = [];
  }

  async start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => this.#onPacket(buf, rinfo));
    await new Promise((r) => this.socket.bind(this.port, this.host, r));
    const t0 = Date.now();
    this.timers.push(
      setInterval(() => {
        const t = Date.now() - t0;
        const values = [];
        for (let i = 1; i <= 16; i++) values.push(this.forced.has(String(i)) ? this.forced.get(String(i)) + (Math.random() - 0.5) * 3 : meterLevel(String(i), t, this.scenario));
        const aux = meterLevel('aux', t, this.scenario);
        values.push(aux, aux);
        while (values.length < 40) values.push(-128);
        this.#broadcast(this.meterSubs, encodeMessage('/meters/1', [encodeMeterBlob(values)]));
      }, 50),
    );
    if (this.chaos) {
      // Every 20 s pretend someone on another iPad routes the click or guide somewhere it shouldn't go.
      const mischief = [
        () => this.externalChange(paths.lr('15'), { type: 'i', value: 1 }),
        () => this.externalChange(paths.send('16', fxSendBuses[0]), { type: 'f', value: 0.6 }),
        () => this.externalChange(paths.send('15', 6), { type: 'f', value: 0.5 }),
      ];
      let i = 0;
      this.timers.push(setInterval(() => mischief[i++ % mischief.length](), 20000));
    }
    if (this.log) console.log(`XR18 simulator listening on ${this.host}:${this.port}${this.chaos ? ' (chaos mode)' : ''}`);
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.socket?.close();
  }

  /** Simulate a change made by someone else (another app, a scene recall). */
  externalChange(address, arg) {
    this.state.set(address, arg);
    if (this.log) console.log(`[sim] external change ${address} = ${arg.value}`);
    this.#broadcast(this.remoteSubs, encodeMessage(address, [arg]));
  }

  get(address) {
    return this.state.get(address)?.value;
  }

  #onPacket(buf, rinfo) {
    let msg;
    try {
      msg = decodeMessage(buf);
    } catch {
      return;
    }
    const key = `${rinfo.address}:${rinfo.port}`;
    const reply = (b) => this.socket.send(b, rinfo.port, rinfo.address);

    if (msg.address === '/xinfo') {
      reply(encodeMessage('/xinfo', ['127.0.0.1', 'XR18-SIM', 'XR18', '1.22']));
      return;
    }
    if (msg.address === '/xremote') {
      this.remoteSubs.set(key, Date.now() + SUB_TTL_MS);
      return;
    }
    if (msg.address === '/meters') {
      this.meterSubs.set(key, Date.now() + SUB_TTL_MS);
      return;
    }
    if (!this.state.has(msg.address)) return; // unknown address: real mixer ignores it too
    if (msg.args.length === 0) {
      reply(encodeMessage(msg.address, [this.state.get(msg.address)]));
      return;
    }
    const cur = this.state.get(msg.address);
    const next = msg.args[0];
    this.state.set(msg.address, { type: cur.type, value: next.value });
    if (this.log) console.log(`[sim] ${key} set ${msg.address} = ${next.value}`);
    // Push to every other /xremote subscriber, not the sender (like the real mixer).
    this.#broadcast(this.remoteSubs, encodeMessage(msg.address, [{ type: cur.type, value: next.value }]), key);
  }

  #broadcast(subs, buf, exceptKey = null) {
    const now = Date.now();
    for (const [key, exp] of subs) {
      if (exp < now) {
        subs.delete(key);
        continue;
      }
      if (key === exceptKey) continue;
      const i = key.lastIndexOf(':');
      this.socket.send(buf, Number(key.slice(i + 1)), key.slice(0, i));
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chaos = process.argv.includes('--chaos');
  const port = Number(process.env.SIM_PORT || OSC_PORT);
  new XR18Simulator({ port, chaos, log: true }).start();
}
