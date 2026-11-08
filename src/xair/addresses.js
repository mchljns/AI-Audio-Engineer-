// Mixer OSC address map. The XR18 (X Air) is the default; an X32 profile is prepared for an
// upgrade (src/xair/profiles.js). The model is chosen once at startup with useMixerModel().
// Source: community-documented X Air / X32 OSC protocols. Verify against real hardware.

import { profileFor } from './profiles.js';

let profile = profileFor('xr18');

// Live bindings: modules read these at call time, so they follow the chosen model. Arrays are
// updated in place so references held elsewhere stay current.
export let MIXER_MODEL = profile.id;
export let OSC_PORT = profile.port;
export let CHANNEL_COUNT = profile.channelCount;
export let AUX_BUS_COUNT = profile.monitorBuses.length; // in-ear mixes
export let FX_SEND_FIRST = profile.fxSendBuses[0]; // the mix send feeding FX1
export let FX_SEND_COUNT = profile.fxSendBuses.length;
export let DCA_COUNT = profile.dcaCount;

/** All input strips the app manages: every channel plus the stereo aux (playback) input. */
export const STRIP_IDS = [];
/** In-ear (monitor) buses: never changed by the app. */
export const AUX_BUSES = [];
/** Mix sends that feed FX1..FX4. */
export const fxSendBuses = [];

/** The active mixer profile (read-only). */
export const mixerProfile = () => profile;

/** Choose the mixer model ('xr18' or 'x32'). Call before creating the mixer state or client. */
export function useMixerModel(model) {
  profile = profileFor(model);
  MIXER_MODEL = profile.id;
  OSC_PORT = profile.port;
  CHANNEL_COUNT = profile.channelCount;
  AUX_BUS_COUNT = profile.monitorBuses.length;
  FX_SEND_FIRST = profile.fxSendBuses[0];
  FX_SEND_COUNT = profile.fxSendBuses.length;
  DCA_COUNT = profile.dcaCount;
  STRIP_IDS.splice(0, STRIP_IDS.length, ...Array.from({ length: CHANNEL_COUNT }, (_, i) => String(i + 1)), 'aux');
  AUX_BUSES.splice(0, AUX_BUSES.length, ...profile.monitorBuses);
  fxSendBuses.splice(0, fxSendBuses.length, ...profile.fxSendBuses);
  return profile;
}
useMixerModel('xr18');

const pad2 = (n) => String(n).padStart(2, '0');

export function stripBase(id) {
  return id === 'aux' ? profile.auxStrip.base : `/ch/${pad2(id)}`;
}

export const paths = {
  name: (id) => `${stripBase(id)}/config/name`,
  color: (id) => `${stripBase(id)}/config/color`,
  on: (id) => `${stripBase(id)}/mix/on`, // 1 = unmuted, 0 = muted
  fader: (id) => `${stripBase(id)}/mix/fader`,
  pan: (id) => `${stripBase(id)}/mix/pan`, // 0..1, 0.5 = centre
  lr: (id) => `${stripBase(id)}/mix/${profile.lrField}`, // 1 = assigned to main L/R (X32: mix/st)
  send: (id, bus) => `${stripBase(id)}/mix/${pad2(bus)}/level`,
  dcaGroups: (id) => `${stripBase(id)}/grp/dca`, // bitmask
  muteGroups: (id) => `${stripBase(id)}/grp/mute`, // bitmask
  dcaFader: (n) => `/dca/${n}/fader`,
  dcaOn: (n) => `/dca/${n}/on`,
  dcaName: (n) => `/dca/${n}/config/name`,
  busName: (n) => `${profile.busPath(n)}/config/name`,
};

/** Every address to query for a strip during a full sync. */
export function stripQueryPaths(id) {
  return [
    paths.name(id),
    paths.color(id),
    paths.on(id),
    paths.fader(id),
    paths.lr(id),
    paths.pan(id),
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
  const auxBase = profile.auxStrip.base;
  let m = address.match(/^\/ch\/(\d\d)\/(.+)$/);
  if (m && Number(m[1]) > CHANNEL_COUNT) return null;
  if (!m && address.startsWith(`${auxBase}/`)) m = [address, null, address.slice(auxBase.length + 1)];
  if (m) {
    const id = m[1] ? String(Number(m[1])) : 'aux';
    const rest = m[2];
    if (rest === 'config/name') return { id, field: 'name' };
    if (rest === 'config/color') return { id, field: 'color' };
    if (rest === 'mix/on') return { id, field: 'on' };
    if (rest === 'mix/fader') return { id, field: 'fader' };
    if (rest === `mix/${profile.lrField}`) return { id, field: 'lr' };
    if (rest === 'mix/pan') return { id, field: 'pan' };
    if (rest === 'grp/dca') return { id, field: 'dcaGroups' };
    if (rest === 'grp/mute') return { id, field: 'muteGroups' };
    const s = rest.match(/^mix\/(\d\d)\/level$/);
    if (s) return { id, field: 'send', bus: Number(s[1]) };
    return null;
  }
  m = address.match(/^\/bus\/(\d\d?)\/config\/name$/);
  if (m && address === paths.busName(Number(m[1]))) return { bus: Number(m[1]), field: 'name' };
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
  const [l, r] = profile.auxStrip.meters;
  if (values.length > r) out.aux = Math.max(values[l], values[r]);
  return out;
}
