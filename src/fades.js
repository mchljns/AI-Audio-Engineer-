import { paths } from './xair/addresses.js';
import { dbToFloat, floatToDb } from './xair/faderLaw.js';

const STEP_MS = 50;
const SILENT_DB = -70; // below this a fade-out is finished; the channel is then muted

/**
 * Smooth fader moves. Fades are linear in dB, which sounds even to the ear.
 * If anyone else moves the fader during a fade, the fade stops and the human wins.
 */
export class FadeEngine {
  constructor({ state, client }) {
    this.state = state;
    this.client = client;
    this.active = new Map(); // id -> fade
    state.on('change', ({ id, field }) => {
      if (field !== 'fader' || !this.active.has(id)) return;
      const f = this.active.get(id);
      if (Math.abs(this.state.strips[id].fader - f.lastSent) > 0.02) this.cancel(id, 'moved by someone else');
    });
  }

  /**
   * Fade strip `id` to `targetDb` over `ms`. With `muteAtEnd`, the channel is muted
   * when it reaches silence. With `unmuteFirst`, it's unmuted before fading up.
   */
  fade(id, targetDb, ms, { muteAtEnd = false, unmuteFirst = false, onDone } = {}) {
    this.cancel(id);
    const s = this.state.strips[id];
    if (!s) return;
    if (unmuteFirst && !s.on) {
      this.client.setInt(paths.on(id), 1);
      s.on = true;
    }
    const startDb = Math.max(floatToDb(s.fader), SILENT_DB - 20);
    const endDb = targetDb === -Infinity ? SILENT_DB - 20 : targetDb;
    const steps = Math.max(1, Math.round(ms / STEP_MS));
    const fade = { step: 0, lastSent: s.fader, timer: null, onDone };
    fade.timer = setInterval(() => {
      fade.step++;
      const t = fade.step / steps;
      const db = startDb + (endDb - startDb) * t;
      const value = fade.step >= steps && targetDb === -Infinity ? 0 : dbToFloat(db);
      fade.lastSent = value;
      s.fader = value;
      s.faderDb = floatToDb(value);
      this.client.setFloat(paths.fader(id), value);
      if (fade.step >= steps) {
        clearInterval(fade.timer);
        this.active.delete(id);
        if (muteAtEnd) {
          this.client.setInt(paths.on(id), 0);
          s.on = false;
        }
        onDone?.('done');
      }
    }, STEP_MS);
    this.active.set(id, fade);
  }

  cancel(id, reason = 'cancelled') {
    const f = this.active.get(id);
    if (!f) return;
    clearInterval(f.timer);
    this.active.delete(id);
    f.onDone?.(reason);
  }

  isFading(id) {
    return this.active.has(id);
  }

  stopAll() {
    for (const id of [...this.active.keys()]) this.cancel(id);
  }
}
