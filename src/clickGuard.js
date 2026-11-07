import fs from 'node:fs';
import path from 'node:path';
import { paths, fxSendBuses, AUX_BUSES, STRIP_IDS } from './xair/addresses.js';
import { resolveRole } from './inventory.js';
import { LOCKED_ROLES, ROLES, normalizeName } from './roles.js';

// Aux buses whose names say they reach people other than the band: the livestream,
// a recording, the lobby, or a wedge/speaker in the room. Click and guide must stay off them.
const PROTECTED_BUS_NAME = /\b(stream|live|livestream|record|rec|broadcast|video|zoom|youtube|facebook|lobby|foyer|overflow|nursery|house|foh|room|wedge|pastor|pulpit|fill)\b/;

export function isProtectedBusName(name) {
  return PROTECTED_BUS_NAME.test(normalizeName(name));
}

/**
 * Channels that have ever been click/guide stay locked until a person says otherwise.
 * If someone renames "Click" to "Ch 15", the channel is still kept out of the house
 * and the volunteer is told, instead of protection quietly disappearing.
 */
export class LockStore {
  constructor(file) {
    this.file = file;
    this.locks = {};
    try {
      this.locks = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
  }

  get(id) {
    return this.locks[id] ?? null;
  }

  set(id, role, name) {
    const cur = this.locks[id];
    if (cur && cur.role === role && cur.name === name) return;
    this.locks[id] = { role, name, since: cur?.since ?? new Date().toISOString() };
    this.#save();
  }

  release(id) {
    if (!this.locks[id]) return;
    delete this.locks[id];
    this.#save();
  }

  #save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.locks, null, 2));
  }
}

/**
 * Keeps click and guide out of the house.
 *
 * For every locked channel:
 *   - main L/R assign is forced OFF
 *   - sends to FX1-4 are forced to zero (FX returns feed the house)
 *   - sends to protected aux buses (livestream, room wedges…) are forced to zero
 *
 * It enforces on every change pushed from the mixer (another app, a scene recall),
 * on each periodic re-sync, and reports each correction as an alert.
 * Sends to the band's own monitor buses are left alone: that's where click and guide belong.
 */
export class ClickGuard {
  constructor({ state, client, roleStore, lockStore = new LockStore(null), protectedBuses = null, onAlert = () => {} }) {
    this.state = state;
    this.client = client;
    this.roleStore = roleStore;
    this.lockStore = lockStore;
    this.configuredBuses = Array.isArray(protectedBuses) ? protectedBuses.map(Number) : null;
    this.onAlert = onAlert;
    this.renameWarned = new Map(); // id -> name we already warned about
  }

  /** Aux buses click/guide must never feed: configured list, else worked out from bus names. */
  protectedBuses() {
    if (this.configuredBuses) return this.configuredBuses;
    return AUX_BUSES.filter((n) => isProtectedBusName(this.state.buses[n]?.name));
  }

  #label(id) {
    return id === 'aux' ? 'Aux' : `Ch ${id}`;
  }

  /** Refresh sticky locks from current names. Returns ids that are locked, with why. */
  #refreshLocks() {
    const out = [];
    for (const id of STRIP_IDS) {
      const s = this.state.strips[id];
      if (!s.synced) continue;
      const { role } = resolveRole(s, this.roleStore);
      const sticky = this.lockStore.get(id);
      if (LOCKED_ROLES.has(role)) {
        this.lockStore.set(id, role, s.name);
        this.renameWarned.delete(id);
        out.push({ id, role, renamed: false });
      } else if (sticky) {
        out.push({ id, role: sticky.role, renamed: true, oldName: sticky.name });
        if (this.renameWarned.get(id) !== s.name) {
          this.renameWarned.set(id, s.name);
          this.onAlert({
            level: 'danger',
            source: 'click-guard',
            id,
            message:
              `${this.#label(id)} was the ${ROLES[sticky.role].label} channel ("${sticky.name}") and is now called "${s.name || 'nothing'}". ` +
              `It's still kept out of the house for safety. If it isn't the ${sticky.role} any more, tap its name strip and choose what it is.`,
          });
        }
      }
    }
    return out;
  }

  lockedStrips() {
    return this.#refreshLocks().map((l) => l.id);
  }

  /** Called when a person sets a channel's role: choosing a non-click/guide role releases the lock. */
  roleChanged(id) {
    const s = this.state.strips[id];
    const { role } = resolveRole(s, this.roleStore);
    if (!LOCKED_ROLES.has(role)) {
      this.lockStore.release(id);
      this.renameWarned.delete(id);
    }
  }

  /** Check one strip (or all) and correct anything unsafe. Returns the fixes made. */
  enforce(onlyId = null) {
    const fixes = [];
    const protectedBuses = this.protectedBuses();
    for (const lock of this.#refreshLocks()) {
      const { id } = lock;
      if (onlyId && id !== onlyId) continue;
      const s = this.state.strips[id];
      const who = `${this.#label(id)} "${s.name}" (${ROLES[lock.role].label})`;

      if (s.lr === true) {
        this.client.setInt(paths.lr(id), 0);
        s.lr = false; // optimistic; the mixer's push or the next re-sync confirms it
        fixes.push({ id, what: 'lr', message: `${who} was assigned to the main speakers. Removed it.` });
      }
      for (const bus of fxSendBuses) {
        if ((s.sends[bus] ?? 0) > 0) {
          const fx = bus - fxSendBuses[0] + 1;
          this.client.setFloat(paths.send(id, bus), 0);
          s.sends[bus] = 0;
          fixes.push({ id, what: `fx${fx}`, message: `${who} had a send to FX${fx}, which would leak into the house. Set it to zero.` });
        }
      }
      for (const bus of protectedBuses) {
        if ((s.sends[bus] ?? 0) > 0) {
          const busName = this.state.buses[bus]?.name || `Aux ${bus}`;
          this.client.setFloat(paths.send(id, bus), 0);
          s.sends[bus] = 0;
          fixes.push({ id, what: `bus${bus}`, message: `${who} was being sent to "${busName}" (aux ${bus}), which people outside the band hear. Set it to zero.` });
        }
      }
    }
    for (const f of fixes) this.onAlert({ level: 'danger', source: 'click-guard', ...f });
    return fixes;
  }

  /** Summary for the UI. */
  status() {
    const protectedBuses = this.protectedBuses();
    const locked = this.#refreshLocks().map(({ id, renamed }) => {
      const s = this.state.strips[id];
      const fxClear = fxSendBuses.every((b) => (s.sends[b] ?? 0) === 0);
      const busesClear = protectedBuses.every((b) => (s.sends[b] ?? 0) === 0);
      const safe = s.lr !== true && fxClear && busesClear;
      return { id, name: s.name, renamed, lrOff: s.lr !== true, fxClear, busesClear, safe };
    });
    return {
      locked,
      allSafe: locked.every((l) => l.safe),
      protectedBuses: protectedBuses.map((n) => ({ n, name: this.state.buses[n]?.name || `Aux ${n}` })),
    };
  }
}
