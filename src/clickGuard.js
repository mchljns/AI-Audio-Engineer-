import { paths, fxSendBuses, STRIP_IDS } from './xair/addresses.js';
import { resolveRole } from './inventory.js';
import { LOCKED_ROLES, ROLES } from './roles.js';

/**
 * Keeps click and guide out of the house.
 *
 * For every channel whose role is click or guide:
 *   - main L/R assign must be OFF
 *   - every FX send (FX1-4) must be at zero, because FX returns feed the house
 *
 * It enforces on every change pushed from the mixer (another app, a scene recall)
 * and on a periodic re-check, and reports each correction as an alert.
 * Monitor sends (aux 1-6) are left alone: that's where click and guide belong.
 */
export class ClickGuard {
  constructor({ state, client, roleStore, onAlert = () => {} }) {
    this.state = state;
    this.client = client;
    this.roleStore = roleStore;
    this.onAlert = onAlert;
  }

  lockedStrips() {
    return STRIP_IDS.filter((id) => LOCKED_ROLES.has(resolveRole(this.state.strips[id], this.roleStore).role));
  }

  /** Check one strip (or all) and correct anything unsafe. Returns the fixes made. */
  enforce(onlyId = null) {
    const fixes = [];
    for (const id of this.lockedStrips()) {
      if (onlyId && id !== onlyId) continue;
      const s = this.state.strips[id];
      if (!s.synced) continue;
      const roleLabel = ROLES[resolveRole(s, this.roleStore).role].label;
      const who = `${id === 'aux' ? 'Aux' : `Ch ${id}`} "${s.name}" (${roleLabel})`;

      if (s.lr === true) {
        this.client.setInt(paths.lr(id), 0);
        s.lr = false; // optimistic; the mixer's echo/re-sync confirms it
        fixes.push({ id, what: 'lr', message: `${who} was assigned to the main speakers. Removed it.` });
      }
      for (const bus of fxSendBuses) {
        if ((s.sends[bus] ?? 0) > 0) {
          this.client.setFloat(paths.send(id, bus), 0);
          s.sends[bus] = 0;
          fixes.push({
            id,
            what: `fx${bus - fxSendBuses[0] + 1}`,
            message: `${who} had a send to FX${bus - fxSendBuses[0] + 1}, which would leak into the house. Set it to zero.`,
          });
        }
      }
    }
    for (const f of fixes) this.onAlert({ level: 'danger', source: 'click-guard', ...f });
    return fixes;
  }

  /** Summary for the UI. */
  status() {
    const locked = this.lockedStrips().map((id) => {
      const s = this.state.strips[id];
      const fxClear = fxSendBuses.every((b) => (s.sends[b] ?? 0) === 0);
      return { id, name: s.name, lrOff: s.lr !== true, fxClear, safe: s.lr !== true && fxClear };
    });
    return { locked, allSafe: locked.every((l) => l.safe) };
  }
}
