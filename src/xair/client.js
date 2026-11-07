import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { encodeMessage, decodeMessage } from '../osc.js';
import { OSC_PORT, STRIP_IDS, DCA_COUNT, paths, stripQueryPaths } from './addresses.js';

const KEEPALIVE_MS = 8000; // /xremote and /meters subscriptions expire after ~10 s
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 6000;

/**
 * UDP OSC client for an XR18.
 * Events: 'message' ({address,args}), 'connected' (info), 'disconnected', 'error'.
 */
export class XAirClient extends EventEmitter {
  constructor({ host, port = OSC_PORT, localPort = 0 } = {}) {
    super();
    this.host = host;
    this.port = port;
    this.localPort = localPort;
    this.connected = false;
    this.info = null;
    this.lastReply = 0;
    this.timers = [];
  }

  async start() {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf) => this.#onPacket(buf));
    this.socket.on('error', (err) => this.emit('error', err));
    await new Promise((resolve) => this.socket.bind(this.localPort, resolve));

    this.#keepalive();
    this.timers.push(setInterval(() => this.#keepalive(), KEEPALIVE_MS));
    this.timers.push(setInterval(() => this.#heartbeat(), HEARTBEAT_MS));
    this.#heartbeat();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.socket?.close();
    this.socket = null;
  }

  send(address, args = []) {
    if (!this.socket || !this.host) return;
    const buf = encodeMessage(address, args);
    this.socket.send(buf, this.port, this.host);
  }

  /** Ask the mixer for a value; the reply arrives as a 'message' event. */
  query(address) {
    this.send(address);
  }

  setFloat(address, value) {
    this.send(address, [{ type: 'f', value }]);
  }

  setInt(address, value) {
    this.send(address, [{ type: 'i', value }]);
  }

  /** Query the full state the app tracks, paced so the mixer isn't flooded. */
  async syncAll() {
    const all = [];
    for (const id of STRIP_IDS) all.push(...stripQueryPaths(id));
    for (let n = 1; n <= DCA_COUNT; n++) all.push(paths.dcaName(n), paths.dcaFader(n), paths.dcaOn(n));
    for (let i = 0; i < all.length; i++) {
      this.query(all[i]);
      if (i % 16 === 15) await new Promise((r) => setTimeout(r, 15));
    }
  }

  #keepalive() {
    this.send('/xremote'); // push parameter changes made from any other app
    this.send('/meters', [{ type: 's', value: '/meters/1' }]); // stream input meters
  }

  #heartbeat() {
    this.send('/xinfo');
    if (this.connected && Date.now() - this.lastReply > TIMEOUT_MS) {
      this.connected = false;
      this.emit('disconnected');
    }
  }

  #onPacket(buf) {
    let msg;
    try {
      msg = decodeMessage(buf);
    } catch (err) {
      this.emit('error', err);
      return;
    }
    this.lastReply = Date.now();
    if (msg.address === '/xinfo') {
      const [ip, name, model, firmware] = msg.args.map((a) => a.value);
      this.info = { ip, name, model, firmware };
      if (!this.connected) {
        this.connected = true;
        this.emit('connected', this.info);
      }
      return;
    }
    if (!this.connected) {
      this.connected = true;
      this.emit('connected', this.info);
    }
    this.emit('message', msg);
  }
}

/** Broadcast /xinfo on the local network and collect mixers that answer. */
export async function discoverMixers({ timeoutMs = 1500, port = OSC_PORT } = {}) {
  const socket = dgram.createSocket('udp4');
  const found = new Map();
  socket.on('message', (buf, rinfo) => {
    try {
      const msg = decodeMessage(buf);
      if (msg.address !== '/xinfo') return;
      const [ip, name, model, firmware] = msg.args.map((a) => a.value);
      found.set(rinfo.address, { host: rinfo.address, ip, name, model, firmware });
    } catch {
      /* ignore non-OSC traffic */
    }
  });
  await new Promise((r) => socket.bind(0, r));
  socket.setBroadcast(true);
  const probe = encodeMessage('/xinfo');
  socket.send(probe, port, '255.255.255.255');
  socket.send(probe, port, '127.0.0.1'); // finds the simulator too
  await new Promise((r) => setTimeout(r, timeoutMs));
  socket.close();
  return [...found.values()];
}
