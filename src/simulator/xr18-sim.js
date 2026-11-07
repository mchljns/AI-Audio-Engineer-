// A pretend XR18 for development and testing without the real mixer.
// Speaks the same OSC over UDP, answers queries, accepts changes, pushes
// changes to /xremote subscribers and streams /meters/1.
//
//   node src/simulator/xr18-sim.js            # normal
//   node src/simulator/xr18-sim.js --chaos    # also misbehaves, to exercise the click guard

import dgram from 'node:dgram';
import { pathToFileURL } from 'node:url';
import { encodeMessage, decodeMessage } from '../osc.js';
import { OSC_PORT, STRIP_IDS, DCA_COUNT, paths, fxSendBuses, encodeMeterBlob } from '../xair/addresses.js';
import { dbToFloat } from '../xair/faderLaw.js';

const SUB_TTL_MS = 10000;

// The church layout from the plan. Ch 4 is named but silent; ch 12 is unnamed with signal.
const LAYOUT = {
  1: { name: 'Pastor', pattern: 'speech', db: -18 },
  2: { name: 'Announce', pattern: 'speech', db: -20 },
  3: { name: 'Vox 1 Lead', pattern: 'sing', db: -16 },
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
  aux: { name: 'Walk-in', pattern: 'steady', db: -14 },
};

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
    st.set(paths.dcaGroups(id), { type: 'i', value: 0 });
    st.set(paths.muteGroups(id), { type: 'i', value: 0 });
    for (const b of fxSendBuses) st.set(paths.send(id, b), { type: 'f', value: 0 });
  }
  for (let n = 1; n <= DCA_COUNT; n++) {
    st.set(paths.dcaName(n), { type: 's', value: ['Speech', 'Vocals', 'Band', 'Tracks'][n - 1] });
    st.set(paths.dcaFader(n), { type: 'f', value: dbToFloat(0) });
    st.set(paths.dcaOn(n), { type: 'i', value: 1 });
  }
  return st;
}

function meterLevel(id, t) {
  const l = LAYOUT[id];
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
  constructor({ port = OSC_PORT, host = '127.0.0.1', chaos = false, log = false } = {}) {
    this.port = port;
    this.host = host;
    this.chaos = chaos;
    this.log = log;
    this.state = initialState();
    this.remoteSubs = new Map(); // "addr:port" -> expiry
    this.meterSubs = new Map();
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
        for (let i = 1; i <= 16; i++) values.push(meterLevel(String(i), t));
        const aux = meterLevel('aux', t);
        values.push(aux, aux);
        while (values.length < 40) values.push(-128);
        this.#broadcast(this.meterSubs, encodeMessage('/meters/1', [encodeMeterBlob(values)]));
      }, 50),
    );
    if (this.chaos) {
      // Every 20 s pretend someone on another iPad routes the click to the house or to reverb.
      let flip = false;
      this.timers.push(
        setInterval(() => {
          flip = !flip;
          if (flip) this.externalChange(paths.lr('15'), { type: 'i', value: 1 });
          else this.externalChange(paths.send('16', fxSendBuses[0]), { type: 'f', value: 0.6 });
        }, 20000),
      );
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chaos = process.argv.includes('--chaos');
  const port = Number(process.env.SIM_PORT || OSC_PORT);
  new XR18Simulator({ port, chaos, log: true }).start();
}
