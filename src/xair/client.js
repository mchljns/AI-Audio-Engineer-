import dgram from 'node:dgram';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { encodeMessage, decodeMessage } from '../osc.js';
import { OSC_PORT, STRIP_IDS, DCA_COUNT, AUX_BUSES, paths, stripQueryPaths } from './addresses.js';

const KEEPALIVE_MS = 8000; // /xremote and /meters subscriptions expire after ~10 s
const HEARTBEAT_MS = 2000;
const TIMEOUT_MS = 6000;

/**
 * UDP OSC client for an XR18.
 * Events: 'message' ({address,args}), 'connected' (info), 'disconnected', 'error'.
 */
/**
 * Writes the app must never make (reads are always fine):
 *   - anything on an aux bus (/bus/…): the in-ear mixes' levels, EQ, dynamics, setup
 *   - a channel's, aux-in's or FX return's send to aux buses 1–6 (the in-ear mixes), except a
 *     bus explicitly listed as protected in config.json, which the click guard keeps clear
 *   - loading or saving mixer snapshots, mixer configuration, phantom power
 */
export function blockedWrite(address, allowedAuxBuses = []) {
  if (/^\/bus\//.test(address)) return true;
  const send = address.match(/^\/(?:ch\/\d\d|rtn\/(?:aux|[1-4]))\/mix\/0([1-6])(?:\/|$)/);
  if (send) return !(allowedAuxBuses ?? []).map(Number).includes(Number(send[1]));
  if (/^\/-?snap/.test(address) || /^\/-?config\//.test(address) || /^\/-?action\//.test(address)) return true;
  if (/^\/headamp\/\d\d\/phantom$/.test(address)) return true;
  return false;
}

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
    await this.#resolveHost();
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => {
      // Only the mixer may talk to us. Anything else on the network is ignored.
      if (rinfo.address !== this.hostIp || rinfo.port !== this.port) return;
      this.#onPacket(buf);
    });
    this.socket.on('error', (err) => this.emit('error', err));
    await new Promise((resolve) => this.socket.bind(this.localPort, resolve));

    this.#keepalive();
    this.timers.push(setInterval(() => this.#keepalive(), KEEPALIVE_MS));
    this.timers.push(setInterval(() => this.#heartbeat(), HEARTBEAT_MS));
    this.#heartbeat();
  }

  async #resolveHost() {
    if (!this.host || net.isIP(this.host)) {
      this.hostIp = this.host;
      return;
    }
    try {
      this.hostIp = (await dns.lookup(this.host, { family: 4 })).address;
    } catch {
      this.hostIp = this.host;
    }
  }

  /** Point at a different mixer address (e.g. the XR18 got a new DHCP address). */
  async setHost(host) {
    this.host = host;
    this.connected = false;
    await this.#resolveHost();
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.socket?.close();
    this.socket = null;
  }

  send(address, args = []) {
    if (!this.socket || !this.host) return;
    if (args.length && blockedWrite(address, this.allowedAuxBuses)) {
      // The one place every write passes: in-ear mixes, snapshots, phantom and mixer setup can
      // never be changed by the app, whatever any other code asks for.
      this.emit('blocked', address);
      return;
    }
    const buf = encodeMessage(address, args);
    this.socket.send(buf, this.port, this.hostIp ?? this.host, (err) => err && this.emit('error', err));
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
    // Bus names first, so the click guard knows which mixes are in-ears before it sees any sends.
    const all = AUX_BUSES.map((b) => paths.busName(b));
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
    this.send('/meters', [{ type: 's', value: '/meters/4' }]); // stream the 100-band analyzer (feedback catcher)
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
      const [ip, name, model, firmware] = msg.args.map((a) => String(a.value));
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
    try {
      this.emit('message', msg);
    } catch (err) {
      this.emit('error', err);
    }
  }
}

/**
 * Broadcast addresses for every IPv4 network this computer is on. A Mac with both
 * Wi-Fi and Ethernet needs a probe on each, or the mixer on the other one is missed.
 */
export function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const out = new Set(['255.255.255.255']);
  for (const addrs of Object.values(interfaces)) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      if (ip.length !== 4 || mask.length !== 4) continue;
      out.add(ip.map((b, i) => (b | (~mask[i] & 255)) & 255).join('.'));
    }
  }
  return [...out];
}

/**
 * Probe the local networks with /xinfo and collect mixers that answer.
 * `extraHosts` adds specific addresses to probe (the dev runner passes 127.0.0.1).
 */
export async function discoverMixers({ timeoutMs = 1500, port = OSC_PORT, extraHosts = [], onSendError = () => {} } = {}) {
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
  socket.on('error', () => {}); // an unreachable broadcast address must not crash the search
  await new Promise((r) => socket.bind(0, r));
  socket.setBroadcast(true);
  const probe = encodeMessage('/xinfo');
  for (const host of [...broadcastAddresses(), ...extraHosts]) {
    socket.send(probe, port, host, (err) => err && onSendError(err, host));
  }
  await new Promise((r) => setTimeout(r, timeoutMs));
  socket.close();
  return [...found.values()];
}
