import fs from 'node:fs';
import path from 'node:path';
import { STRIP_IDS, fxSendBuses } from './xair/addresses.js';
import { ROLES, LOCKED_ROLES, classifyName, isDefaultName, stereoSide } from './roles.js';

/**
 * Remembers roles a volunteer has confirmed. A confirmation is tied to the channel
 * name it was made under: if someone renames the channel, the app re-reads the name
 * instead of trusting an old answer.
 */
export class RoleStore {
  constructor(file) {
    this.file = file;
    this.overrides = {};
    try {
      this.overrides = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      /* first run */
    }
  }

  get(id, name) {
    const o = this.overrides[id];
    return o && o.name === name ? o.role : null;
  }

  set(id, name, role) {
    if (role === null) delete this.overrides[id];
    else this.overrides[id] = { name, role, confirmedAt: new Date().toISOString() };
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.overrides, null, 2));
  }
}

export function resolveRole(strip, roleStore) {
  const confirmed = roleStore?.get(strip.id, strip.name);
  if (confirmed) return { role: confirmed, source: 'confirmed' };
  const role = classifyName(strip.name);
  return { role, source: role === 'none' ? 'none' : 'name' };
}

/**
 * Build the channel inventory: what each channel is, whether it's live,
 * and what needs a volunteer's attention.
 */
export function buildInventory(state, roleStore, now = Date.now(), lockedIds = [], { monoPA = false } = {}) {
  const lockedSet = new Set(lockedIds);
  const rows = STRIP_IDS.map((id) => {
    const s = state.strips[id];
    const { role, source } = resolveRole(s, roleStore);
    const labeled = !isDefaultName(s.name);
    const signal = state.hasSignal(id, now);
    let status;
    if (labeled && signal) status = 'in-use';
    else if (labeled) status = 'silent';
    else if (signal) status = 'unlabeled-signal';
    else status = 'unused';

    return {
      id,
      label: id === 'aux' ? 'Aux 17/18' : `Ch ${id}`,
      name: s.name,
      role,
      roleLabel: ROLES[role]?.label ?? role,
      roleSource: source,
      group: ROLES[role]?.group ?? 'other',
      locked: LOCKED_ROLES.has(role) || lockedSet.has(id),
      stereo: stereoSide(s.name),
      status,
      signal,
      levelDb: s.levelDb,
      on: s.on,
      fader: s.fader,
      faderDb: s.faderDb,
      lr: s.lr === true,
      pan: s.pan,
      // Both XR18 mains are summed into one PA feed. Stereo pairs (Keys L/R) arrive whole; a single
      // channel panned well to one side just comes out a few dB quieter than it looks.
      offCenter: monoPA && s.lr === true && labeled && !stereoSide(s.name) && Math.abs(s.pan - 0.5) > 0.3 && !LOCKED_ROLES.has(role) && !lockedSet.has(id),
      fxSends: fxSendBuses.map((b) => s.sends[b] ?? 0),
      needsConfirm: role === 'unknown' || status === 'unlabeled-signal',
    };
  });

  const counts = {
    inUse: rows.filter((r) => r.status === 'in-use').length,
    silent: rows.filter((r) => r.status === 'silent').length,
    unlabeledSignal: rows.filter((r) => r.status === 'unlabeled-signal').length,
    unused: rows.filter((r) => r.status === 'unused').length,
    unusedOpen: rows.filter((r) => r.status === 'unused' && r.on).length,
  };
  const tracksPresent = rows.some((r) => r.role === 'track');
  const tracksPlaying = rows.some((r) => r.role === 'track' && r.signal);
  return { rows, counts, tracks: { present: tracksPresent, playing: tracksPlaying } };
}
