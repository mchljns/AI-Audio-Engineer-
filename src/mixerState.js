import { EventEmitter } from 'node:events';
import { STRIP_IDS, DCA_COUNT, AUX_BUSES, parseAddress, decodeMeterBlob, metersToStrips } from './xair/addresses.js';
import { floatToDb } from './xair/faderLaw.js';

const SIGNAL_THRESHOLD_DB = -50; // above this the channel counts as "has signal"
const SIGNAL_MEMORY_MS = 15000; // how long a channel stays "has signal" after the last activity

function emptyStrip(id) {
  return {
    id,
    name: '',
    color: 0,
    on: true,
    fader: 0,
    faderDb: -Infinity,
    lr: null, // unknown until the mixer reports it
    pan: 0.5,
    dcaGroups: 0,
    muteGroups: 0,
    sends: {}, // bus number -> float level
    levelDb: -128,
    lastSignalAt: 0,
    synced: false,
  };
}

/**
 * Local mirror of the mixer, kept up to date from OSC replies, /xremote pushes and meters.
 * Events: 'change' ({ id, field }) and 'meters'.
 */
export class MixerState extends EventEmitter {
  constructor() {
    super();
    this.strips = Object.fromEntries(STRIP_IDS.map((id) => [id, emptyStrip(id)]));
    this.dcas = Object.fromEntries(
      Array.from({ length: DCA_COUNT }, (_, i) => [i + 1, { n: i + 1, name: '', fader: 0, faderDb: -Infinity, on: true }]),
    );
    this.buses = Object.fromEntries(AUX_BUSES.map((n) => [n, { n, name: '', synced: false }]));
  }

  /** Apply one OSC message. Returns true if it changed tracked state. */
  apply(msg, now = Date.now()) {
    if (msg.address === '/meters/4') {
      // The 100-band analyzer (RTA): dB per band, low to high.
      const blob = msg.args[0]?.value;
      if (Buffer.isBuffer(blob)) this.emit('rta', decodeMeterBlob(blob), now);
      return false;
    }
    if (msg.address === '/meters/1') {
      const blob = msg.args[0]?.value;
      if (Buffer.isBuffer(blob)) this.applyMeters(metersToStrips(decodeMeterBlob(blob)), now);
      return true;
    }
    const p = parseAddress(msg.address);
    if (!p || msg.args.length === 0) return false;
    const v = msg.args[0].value;
    // Ignore replies with the wrong kind of value rather than storing nonsense.
    const numeric = ['fader', 'on', 'lr', 'pan', 'dcaGroups', 'muteGroups', 'send', 'color'];
    if (numeric.includes(p.field) && !Number.isFinite(v)) return false;
    if (p.field === 'name' && typeof v !== 'string') return false;

    if (p.bus && p.field === 'name' && !p.id) {
      if (!this.buses[p.bus]) return false;
      this.buses[p.bus].name = String(v).trim();
      this.buses[p.bus].synced = true;
      this.emit('change', { busName: p.bus });
      return true;
    }

    if (p.dca) {
      const d = this.dcas[p.dca];
      if (!d) return false;
      if (p.field === 'fader') {
        d.fader = v;
        d.faderDb = floatToDb(v);
      } else if (p.field === 'on') d.on = v === 1;
      else if (p.field === 'name') d.name = String(v);
      this.emit('change', { dca: p.dca, field: p.field });
      return true;
    }

    const s = this.strips[p.id];
    if (!s) return false;
    switch (p.field) {
      case 'name':
        s.name = String(v).trim();
        s.synced = true;
        break;
      case 'color':
        s.color = v;
        break;
      case 'on':
        s.on = v === 1;
        break;
      case 'fader':
        s.fader = v;
        s.faderDb = floatToDb(v);
        break;
      case 'lr':
        s.lr = v === 1;
        break;
      case 'pan':
        s.pan = Math.min(1, Math.max(0, v));
        break;
      case 'dcaGroups':
        s.dcaGroups = v;
        break;
      case 'muteGroups':
        s.muteGroups = v;
        break;
      case 'send':
        s.sends[p.bus] = v;
        break;
      default:
        return false;
    }
    this.emit('change', { id: p.id, field: p.field, bus: p.bus });
    return true;
  }

  applyMeters(levels, now = Date.now()) {
    if (!this.metersSince) this.metersSince = now;
    this.lastMetersAt = now;
    for (const [id, db] of Object.entries(levels)) {
      if (!Number.isFinite(db)) continue;
      const s = this.strips[id];
      if (!s) continue;
      s.levelDb = db;
      if (db > SIGNAL_THRESHOLD_DB) s.lastSignalAt = now;
    }
    this.emit('meters');
  }

  /** True once every channel name has arrived and meters have flowed for `ms`. */
  settled(ms = 15000, now = Date.now()) {
    const named = Object.values(this.strips).every((s) => s.synced);
    const metersFresh = this.lastMetersAt && now - this.lastMetersAt < 2000;
    return named && metersFresh && now - this.metersSince >= ms;
  }

  hasSignal(id, now = Date.now()) {
    const s = this.strips[id];
    return !!s && s.lastSignalAt > 0 && now - s.lastSignalAt < SIGNAL_MEMORY_MS;
  }
}
