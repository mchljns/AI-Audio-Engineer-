// XR18 OSC address map (X Air series, firmware 1.x).
// Source: community-documented X Air OSC protocol. Verify against real hardware.

export const OSC_PORT = 10024;
export const CHANNEL_COUNT = 16;
export const AUX_BUS_COUNT = 6; // mix sends 01..06 = aux buses (monitors)
export const FX_SEND_FIRST = 7; // mix sends 07..10 = FX1..FX4 sends
export const FX_SEND_COUNT = 4;
export const DCA_COUNT = 4;

/** All input strips the app manages: ch1..ch16 plus the stereo aux input (17/18). */
export const STRIP_IDS = [...Array.from({ length: CHANNEL_COUNT }, (_, i) => String(i + 1)), 'aux'];

const pad2 = (n) => String(n).padStart(2, '0');

export function stripBase(id) {
  return id === 'aux' ? '/rtn/aux' : `/ch/${pad2(id)}`;
}

export const paths = {
  name: (id) => `${stripBase(id)}/config/name`,
  color: (id) => `${stripBase(id)}/config/color`,
  on: (id) => `${stripBase(id)}/mix/on`, // 1 = unmuted, 0 = muted
  fader: (id) => `${stripBase(id)}/mix/fader`,
  lr: (id) => `${stripBase(id)}/mix/lr`, // 1 = assigned to main L/R
  send: (id, bus) => `${stripBase(id)}/mix/${pad2(bus)}/level`,
  dcaGroups: (id) => `${stripBase(id)}/grp/dca`, // bitmask
  muteGroups: (id) => `${stripBase(id)}/grp/mute`, // bitmask
  dcaFader: (n) => `/dca/${n}/fader`,
  dcaOn: (n) => `/dca/${n}/on`,
  dcaName: (n) => `/dca/${n}/config/name`,
  busName: (n) => `/bus/${n}/config/name`,
};

/** Aux buses 1..6 (monitor mixes, livestream feed, etc.). */
export const AUX_BUSES = Array.from({ length: AUX_BUS_COUNT }, (_, i) => i + 1);

export const fxSendBuses = Array.from({ length: FX_SEND_COUNT }, (_, i) => FX_SEND_FIRST + i);

/** Every address to query for a strip during a full sync. */
export function stripQueryPaths(id) {
  return [
    paths.name(id),
    paths.color(id),
    paths.on(id),
    paths.fader(id),
    paths.lr(id),
    paths.dcaGroups(id),
    paths.muteGroups(id),
    ...fxSendBuses.map((b) => paths.send(id, b)),
    ...AUX_BUSES.map((b) => paths.send(id, b)),
  ];
}

/**
 * Parse an address into { id, field, bus? } for strip addresses, or { dca, field } for DCAs.
 * Returns null for anything the app doesn't track.
 */
export function parseAddress(address) {
  let m = address.match(/^\/(?:ch\/(\d\d)|rtn\/(aux))\/(.+)$/);
  if (m) {
    const id = m[1] ? String(Number(m[1])) : 'aux';
    const rest = m[3];
    if (rest === 'config/name') return { id, field: 'name' };
    if (rest === 'config/color') return { id, field: 'color' };
    if (rest === 'mix/on') return { id, field: 'on' };
    if (rest === 'mix/fader') return { id, field: 'fader' };
    if (rest === 'mix/lr') return { id, field: 'lr' };
    if (rest === 'grp/dca') return { id, field: 'dcaGroups' };
    if (rest === 'grp/mute') return { id, field: 'muteGroups' };
    const s = rest.match(/^mix\/(\d\d)\/level$/);
    if (s) return { id, field: 'send', bus: Number(s[1]) };
    return null;
  }
  m = address.match(/^\/bus\/(\d)\/config\/name$/);
  if (m) return { bus: Number(m[1]), field: 'name' };
  m = address.match(/^\/dca\/(\d)\/(fader|on|config\/name)$/);
  if (m) return { dca: Number(m[1]), field: m[2] === 'config/name' ? 'name' : m[2] };
  return null;
}

/**
 * Decode an X Air meter blob. Layout: int32 LE value count, then int16 LE values
 * in 1/256 dB. /meters/1 order: 16 channels, aux L/R, FX returns, buses, ...
 */
export function decodeMeterBlob(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < 4) return [];
  const count = blob.readInt32LE(0);
  const n = Math.max(0, Math.min(count, Math.floor((blob.length - 4) / 2), 256));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = blob.readInt16LE(4 + i * 2) / 256;
  return out;
}

export function encodeMeterBlob(dbValues) {
  const buf = Buffer.alloc(4 + dbValues.length * 2);
  buf.writeInt32LE(dbValues.length, 0);
  dbValues.forEach((db, i) => {
    const v = Math.max(-32768, Math.min(32767, Math.round(Math.max(db, -128) * 256)));
    buf.writeInt16LE(v, 4 + i * 2);
  });
  return buf;
}

/** Map a /meters/1 value array to { stripId: dB } (aux = louder of L/R). */
export function metersToStrips(values) {
  const out = {};
  for (let i = 0; i < CHANNEL_COUNT && i < values.length; i++) out[String(i + 1)] = values[i];
  if (values.length > 17) out.aux = Math.max(values[16], values[17]);
  return out;
}
