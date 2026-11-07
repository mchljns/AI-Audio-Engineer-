// Which connection does the Mac use to reach the mixer: Wi-Fi or a cable?
//
// macOS names its network ports ("Wi-Fi", "USB 10/100/1000 LAN", "Thunderbolt Ethernet"…);
// `networksetup -listallhardwareports` lists them without needing an administrator password.
// Elsewhere (tests, Linux) the interface name is used as a hint.

import os from 'node:os';
import { execFile } from 'node:child_process';

export const CONNECTION_MODES = {
  auto: 'Automatic',
  wifi: 'Prefer Wi-Fi',
  cable: 'Prefer cable',
};

const KIND_LABEL = { wifi: 'Wi-Fi', cable: 'cable', phone: 'iPhone', local: 'this computer', other: 'network' };
export const kindLabel = (k) => KIND_LABEL[k] ?? 'network';

/** Parse `networksetup -listallhardwareports` into { en0: 'Wi-Fi', en7: 'USB 10/100/1000 LAN', … }. */
export function parseHardwarePorts(text) {
  const map = {};
  let port = null;
  for (const line of String(text).split('\n')) {
    const p = line.match(/^Hardware Port:\s*(.+)$/);
    if (p) port = p[1].trim();
    const d = line.match(/^Device:\s*(\S+)/);
    if (d && port) {
      map[d[1]] = port;
      port = null;
    }
  }
  return map;
}

let cache = { at: 0, map: {} };
/** macOS hardware port names, refreshed at most once a minute. */
export async function hardwarePorts({ platform = process.platform, run = runNetworksetup } = {}) {
  if (platform !== 'darwin') return {};
  if (Date.now() - cache.at < 60000) return cache.map;
  try {
    cache = { at: Date.now(), map: parseHardwarePorts(await run()) };
  } catch {
    cache = { at: Date.now(), map: {} };
  }
  return cache.map;
}

function runNetworksetup() {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/networksetup', ['-listallhardwareports'], { timeout: 3000 }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
}

/** What kind of connection an interface is. */
export function kindOf(iface, portMap = {}) {
  const port = portMap[iface];
  if (port) {
    if (/wi-?fi|airport/i.test(port)) return 'wifi';
    if (/iphone|ipad/i.test(port)) return 'phone';
    if (/ethernet|lan\b|10\/100/i.test(port)) return 'cable';
    return 'other';
  }
  if (/^lo/.test(iface)) return 'local';
  if (/^(wl|wlan|wifi)/i.test(iface)) return 'wifi';
  if (/^(eth|enp|ens|eno)/i.test(iface)) return 'cable';
  return 'other';
}

function inSubnet(ip, addr, mask) {
  const a = ip.split('.').map(Number);
  const b = addr.split('.').map(Number);
  const m = mask.split('.').map(Number);
  if (a.length !== 4 || b.length !== 4 || m.length !== 4) return false;
  return a.every((x, i) => (x & m[i]) === (b[i] & m[i]));
}

/** The Mac's interface on the same network as `ip`, and what kind it is. */
export function pathTo(ip, { interfaces = os.networkInterfaces(), portMap = {} } = {}) {
  if (!ip) return null;
  if (ip.startsWith('127.')) return { iface: 'lo', kind: 'local', local: '127.0.0.1', port: null };
  for (const [iface, addrs] of Object.entries(interfaces)) {
    for (const a of addrs ?? []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      if (inSubnet(ip, a.address, a.netmask)) return { iface, kind: kindOf(iface, portMap), local: a.address, port: portMap[iface] ?? null };
    }
  }
  return { iface: null, kind: 'other', local: null, port: null };
}

/**
 * Choose which answering mixer address to use. `found` are discovery results ({ host, … }),
 * each with a `path` from pathTo(). Preferences fall back rather than leave you with no mixer.
 */
export function chooseMixer(found, mode = 'auto', mixerName = null) {
  const list = mixerName ? found.filter((m) => m.name === mixerName) : found;
  if (!list.length) return { pick: null, preferenceMet: false };
  const byKind = (k) => list.find((m) => m.path?.kind === k);
  if (mode === 'wifi') {
    const m = byKind('wifi');
    return m ? { pick: m, preferenceMet: true } : { pick: list[0], preferenceMet: false };
  }
  if (mode === 'cable') {
    const m = byKind('cable');
    return m ? { pick: m, preferenceMet: true } : { pick: list[0], preferenceMet: false };
  }
  // Automatic: a cable is steadier than Wi-Fi when both reach the mixer.
  return { pick: byKind('cable') ?? byKind('wifi') ?? list[0], preferenceMet: true };
}
