// Mixer models Mix Assistant can talk to. The XR18 is the one in use and the default.
//
// The X32 profile is prepared for an upgrade and has NOT been run on a real X32. It follows the
// community-documented X32 OSC protocol, which is a close relative of the X Air one. Entries
// marked CHECK are the ones to confirm on real hardware first (see docs/ROADMAP.md).

const pad2 = (n) => String(n).padStart(2, '0');
const pad3 = (n) => String(n).padStart(3, '0');

export const PROFILES = {
  xr18: {
    id: 'xr18',
    label: 'Behringer XR18 (X Air)',
    short: 'XR18',
    tested: true,
    port: 10024,
    channelCount: 16,
    dcaCount: 4,
    // In-ear (monitor) buses: never changed by the app.
    monitorBuses: [1, 2, 3, 4, 5, 6],
    // Every bus the mixer has, for reading names.
    busCount: 6,
    // Mix sends that feed FX1..FX4.
    fxSendBuses: [7, 8, 9, 10],
    fxCount: 4,
    auxStrip: { base: '/rtn/aux', label: 'Aux 17/18', meters: [16, 17] },
    lrField: 'lr',
    busPath: (n) => `/bus/${n}`,
    fxReturnFader: (fx) => `/rtn/${fx}/mix/fader`,
    fxReturnPattern: /^\/rtn\/([1-4])\/mix\/fader$/,
    fxReturnFromMatch: (m) => Number(m[1]),
    headampBase: (ch) => `/headamp/${pad2(ch)}`,
    channelFromHeadamp: (n) => Number(n),
    rtaAddress: '/meters/4', // 100-band analyzer used by the feedback catcher
  },
  x32: {
    id: 'x32',
    label: 'Behringer X32 / X32 Rack (not tested yet)',
    short: 'X32',
    tested: false,
    port: 10023,
    channelCount: 32,
    dcaCount: 8,
    // Buses 1–12 are treated as in-ear mixes and never changed; 13–16 feed the effects.
    monitorBuses: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    busCount: 16,
    // CHECK: the X32 has no dedicated FX sends. This assumes FX1–4 are fed from buses 13–16
    // (set each effect's source to its bus on the X32).
    fxSendBuses: [13, 14, 15, 16],
    fxCount: 4,
    // CHECK: computer playback assumed on aux inputs 7/8 (the X32's usual USB player inputs).
    auxStrip: { base: '/auxin/07', label: 'Aux 7/8', meters: [38, 39] },
    lrField: 'st',
    busPath: (n) => `/bus/${pad2(n)}`,
    // CHECK: FX1 returns on fxrtn 01/02 (stereo-linked), FX2 on 03/04, and so on.
    fxReturnFader: (fx) => `/fxrtn/${pad2(fx * 2 - 1)}/mix/fader`,
    fxReturnPattern: /^\/fxrtn\/(01|03|05|07)\/mix\/fader$/,
    fxReturnFromMatch: (m) => (Number(m[1]) + 1) / 2,
    // CHECK: assumes default routing, channel N on local or first stage-box input N.
    headampBase: (ch) => `/headamp/${pad3(Number(ch) - 1)}`,
    channelFromHeadamp: (n) => Number(n) + 1,
    rtaAddress: null, // CHECK: X32 analyzer not mapped yet, so the feedback catcher stays off
  },
};

export const MIXER_MODELS = Object.keys(PROFILES);

export function profileFor(model) {
  return PROFILES[String(model ?? '').toLowerCase()] ?? PROFILES.xr18;
}
