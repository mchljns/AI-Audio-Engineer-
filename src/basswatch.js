// Bass weeks: when a bassist is playing, keys and acoustic thin their low end so the two don't
// stack up; on weeks without one, they keep it (the keys carry the low end).
//
// Detection uses the bass channel's meter during worship: playing about 40% of the time for 5 s
// means "bass is here"; under 5% for 30 s means "no bass" (a bassist laying out for one verse
// doesn't flip it). Changes are made between songs, never mid-song, and put back exactly.

const ON_FRAC = 0.4;
const ON_FOR_MS = 5000;
const OFF_FRAC = 0.05;
const OFF_FOR_MS = 30000;
const WINDOW_MS = 10000;
export const BASS_LOW_CUT = { keys: 120, acoustic: 110 };

export class BassWatch {
  constructor() {
    this.present = false;
    this.frames = []; // [{ t, active }]
    this.since = 0; // when the current reading started pointing the other way
    this.raised = new Map(); // channel -> low cut it had before we raised it ({ hpOn, hpHz })
    this.pending = false;
  }

  /** One meter frame: bass levels (dB), in worship or not. Returns true when the state flips. */
  feed(levels, worship, now) {
    if (!levels.length) {
      const flip = this.present;
      this.present = false;
      this.frames = [];
      if (flip) this.pending = true;
      return flip;
    }
    if (!worship) return false; // only judge during songs
    this.frames.push({ t: now, active: Math.max(...levels) > -45 });
    this.frames = this.frames.filter((f) => now - f.t <= WINDOW_MS);
    const frac = this.frames.filter((f) => f.active).length / this.frames.length;
    const pointing = this.present ? frac < OFF_FRAC : frac > ON_FRAC;
    if (!pointing) {
      this.since = 0;
      return false;
    }
    this.since ||= now;
    if (now - this.since >= (this.present ? OFF_FOR_MS : ON_FOR_MS)) {
      this.present = !this.present;
      this.since = 0;
      this.pending = true;
      return true;
    }
    return false;
  }
}
