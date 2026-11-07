// Feedback catcher, from the XR18's 100-band analyzer (/meters/4).
//
// Feedback is one narrow tone that keeps growing. Music isn't: a sung or played note has
// harmonics above it and holds steady. So a band is called "ringing" only when, over most of the
// last ~0.6 s, it:
//   - stands well above the spectrum (15 dB over the median) and above its neighbours (8 dB),
//   - has no strong harmonics at 2× and 3× its frequency, and isn't one (nothing strong at ½ or ⅓),
//   - is loud enough to matter (above −40 dB) and has risen at least 6 dB in the last second.
// Bands are assumed log-spaced 20 Hz–20 kHz (confirm on the mixer: QA P15).

export const RTA_BANDS = 100;
export const bandHz = (i) => 20 * 1000 ** (i / (RTA_BANDS - 1));
const OCTAVE_BANDS = (RTA_BANDS - 1) / Math.log2(1000); // ≈ 9.9 bands per octave
const HISTORY_MS = 1200;

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export class FeedbackDetector {
  constructor() {
    this.frames = []; // [{ t, v: [dB × 100] }]
    this.caught = new Map(); // band -> last time it was reported
  }

  /** One analyzer frame. Returns { band, hz, db } when a band is ringing, else null. */
  feed(values, now) {
    if (!Array.isArray(values) || values.length < RTA_BANDS) return null;
    this.frames.push({ t: now, v: values.slice(0, RTA_BANDS) });
    this.frames = this.frames.filter((f) => now - f.t <= HISTORY_MS);
    if (this.frames.length < 8) return null;
    const recent = this.frames.filter((f) => now - f.t <= 600);
    const cur = this.frames.at(-1).v;
    let best = null;
    for (let i = 3; i < RTA_BANDS - 3; i++) {
      const isPeak = (v) => {
        const med = median(v);
        const neighbours = Math.max(v[i - 3], v[i - 2], v[i + 2], v[i + 3]);
        const h2 = v[Math.round(i + OCTAVE_BANDS)] ?? -128;
        const h3 = v[Math.round(i + OCTAVE_BANDS * Math.log2(3))] ?? -128;
        // …and isn't itself a harmonic of a note below it (a sung or played note's 2nd/3rd partial).
        const s2 = v[Math.round(i - OCTAVE_BANDS)] ?? -128;
        const s3 = v[Math.round(i - OCTAVE_BANDS * Math.log2(3))] ?? -128;
        return v[i] - med >= 15 && v[i] - neighbours >= 8 && v[i] > -40 && h2 < v[i] - 12 && h3 < v[i] - 12 && s2 < v[i] - 12 && s3 < v[i] - 12;
      };
      if (!isPeak(cur)) continue;
      if (recent.filter((f) => isPeak(f.v)).length < recent.length * 0.8) continue;
      // Growing (a new ring), or a band already caught in the last 5 s that is still ringing
      // (a ring stuck at full level has stopped growing, and matters most).
      const rise = cur[i] - Math.min(...this.frames.map((f) => f.v[i]));
      const caught = this.caught.has(i) && now - this.caught.get(i) < 5000;
      if (rise < 6 && !caught) continue;
      if (!best || cur[i] > best.db) best = { band: i, hz: Math.round(bandHz(i)), db: cur[i] };
    }
    if (best) this.caught.set(best.band, now);
    return best;
  }

  reset() {
    this.frames = [];
  }
}
