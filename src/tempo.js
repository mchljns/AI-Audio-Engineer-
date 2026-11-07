// Live tempo, from the channel meters.
//
// Best source: the click (when tracks are running it pulses exactly on the beat). Then the
// tracks' stems (drums, percussion), then the band (a strummed acoustic, keys). The meters only
// arrive about 20 times a second, so one beat is timed to ±25 ms at best; fitting a straight line
// through 10+ seconds of beats brings that to well under 1 BPM.
//
// It only reports a tempo when the beats are steady (small timing spread, enough of them), and
// it keeps the tempo in a normal song range: double-time clicks (eighth notes) are folded back
// using the song's known tempo when there is one.

const WINDOW_MS = 12000; // beats considered
const MIN_ONSETS = 8;
const RISE_DB = 9; // a beat: the level jumps this much from one meter frame to the next…
const FLOOR_DB = -50; // …to above this
const REFRACTORY_MS = 180; // ignore a second "beat" this soon after one (fastest: ~330 BPM eighths)
const MAX_SPREAD_MS = 30; // timing spread of the fitted beats for a trustworthy tempo

export const TEMPO_SOURCES = { click: 'the click', track: 'the tracks', band: 'the band' };

export class TempoDetector {
  constructor() {
    this.sources = new Map(); // source -> { prev, onsets: [], lastOnset }
    this.result = null; // { bpm, source, spreadMs, beats, at }
    this.lastEstimate = 0;
  }

  /**
   * Feed one meter frame. `groups` = { click: [dB...], track: [dB...], band: [dB...] } — the
   * levels of the channels in each source right now.
   */
  feed(groups, now, hintBpm = null) {
    for (const [src, levels] of Object.entries(groups)) {
      if (!levels?.length) continue;
      const level = Math.max(...levels);
      let st = this.sources.get(src);
      if (!st) this.sources.set(src, (st = { prev: level, onsets: [], lastOnset: 0 }));
      if (level - st.prev >= RISE_DB && level > FLOOR_DB && now - st.lastOnset >= REFRACTORY_MS) {
        st.onsets.push(now);
        st.lastOnset = now;
      }
      st.prev = level;
      st.onsets = st.onsets.filter((t) => now - t <= WINDOW_MS);
    }
    if (now - this.lastEstimate >= 1000) {
      this.lastEstimate = now;
      // One uneven estimate doesn't make the tempo blink out: hold the last good one for 4 s.
      const held = this.result && now - this.result.at <= 4000 ? this.result : null;
      this.result = null;
      for (const src of ['click', 'track', 'band']) {
        const st = this.sources.get(src);
        if (!st || now - st.lastOnset > 2500) continue; // gone quiet
        const r = estimate(st.onsets, hintBpm);
        if (r) {
          this.result = { ...r, source: src, at: now };
          break;
        }
      }
      if (!this.result && held && now - (this.sources.get(held.source)?.lastOnset ?? 0) <= 2500) this.result = held;
    }
    return this.result;
  }

  reset() {
    this.sources.clear();
    this.result = null;
  }
}

/** Tempo from beat times: median gap, then a straight-line fit through every beat. */
export function estimate(onsets, hintBpm = null) {
  if (onsets.length < MIN_ONSETS) return null;
  const gaps = onsets.slice(1).map((t, i) => t - onsets[i]);
  const sorted = [...gaps].sort((a, b) => a - b);
  let period = sorted[Math.floor(sorted.length / 2)];
  if (!(period > 150 && period < 1600)) return null;
  // Fit: beat k at time a + k·period. Beats are counted gap by gap (a missed beat is a gap of 2),
  // so a rough first period can't drift; then a straight line through all of them, twice.
  const n = onsets.length;
  let ks = [];
  let a = 0;
  for (let pass = 0; pass < 2; pass++) {
    ks = [0];
    for (let i = 1; i < n; i++) ks.push(ks[i - 1] + Math.max(1, Math.round((onsets[i] - onsets[i - 1]) / period)));
    const mk = ks.reduce((x, y) => x + y, 0) / n;
    const mt = onsets.reduce((x, y) => x + y, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      num += (ks[i] - mk) * (onsets[i] - mt);
      den += (ks[i] - mk) ** 2;
    }
    if (den === 0) return null;
    period = num / den;
    a = mt - period * mk;
  }
  const spread = Math.sqrt(onsets.reduce((s, t, i) => s + (t - (a + period * ks[i])) ** 2, 0) / n);
  // Too many beats off the grid: not a steady pulse (talking, a free-time intro, rubato).
  const offGrid = onsets.filter((t, i) => Math.abs(t - (a + period * ks[i])) > period * 0.2).length;
  if (spread > MAX_SPREAD_MS || offGrid > n * 0.15) return null;
  let bpm = 60000 / period;
  // Fold into a normal song range; prefer the octave nearest the song's known tempo.
  const options = [bpm / 4, bpm / 2, bpm, bpm * 2].filter((b) => b >= 50 && b <= 180);
  if (!options.length) return null;
  bpm = hintBpm ? options.reduce((best, b) => (Math.abs(Math.log2(b / hintBpm)) < Math.abs(Math.log2(best / hintBpm)) ? b : best)) : (bpm >= 60 && bpm <= 165 ? bpm : options.reduce((best, b) => (Math.abs(Math.log2(b / 100)) < Math.abs(Math.log2(best / 100)) ? b : best)));
  return { bpm: Math.round(bpm * 10) / 10, spreadMs: Math.round(spread), beats: n };
}
