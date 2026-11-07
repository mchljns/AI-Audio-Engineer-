// Work out what a channel is from its name on the mixer.

export const ROLES = {
  pastor: { label: 'Pastor', group: 'speech' },
  speech: { label: 'Speech / announcements', group: 'speech' },
  vocal: { label: 'Singer', group: 'vocals' },
  acoustic: { label: 'Acoustic guitar', group: 'band' },
  guitar: { label: 'Guitar', group: 'band' },
  keys: { label: 'Keys', group: 'band' },
  bass: { label: 'Bass', group: 'band' },
  drums: { label: 'Drums', group: 'band' },
  instrument: { label: 'Other instrument', group: 'band' },
  track: { label: 'Track (Prime stem)', group: 'tracks' },
  click: { label: 'Click', group: 'locked' },
  guide: { label: 'Guide / cues', group: 'locked' },
  walkin: { label: 'Walk-in / pre-service music', group: 'playback' },
  room: { label: 'Room / ambient mic', group: 'other' },
  unknown: { label: 'Unknown — please confirm', group: 'other' },
  none: { label: 'Unlabeled', group: 'other' },
};

/** Roles that must never reach the house (main L/R or FX returns). */
export const LOCKED_ROLES = new Set(['click', 'guide']);

// Order matters: safety-critical roles first.
const RULES = [
  ['click', /\b(click|clk|metro|metronome)\b/],
  ['guide', /\b(guide|gd|cues?)\b/],
  ['walkin', /\b(walk ?in|pre ?service|preservice|bgm|spotify|playback|house music|music)\b/],
  ['track', /\b(trk|tracks?|stems?|prime|loops?|mt|multitracks?|pads?)\b/],
  ['pastor', /\b(pastor|pstr|ptr|preach|preacher|sermon|pulpit|rev)\b/],
  ['speech', /\b(announce|announcements?|ann|podium|lectern|host|mc|speech|talk|wl)\b/],
  ['vocal', /\b(vox|vocals?|voc|vo|lead|ld|bv|bgv|sing|singer|choir|harmony|alto|sop|soprano|tenor)\b/],
  ['acoustic', /\b(ag|ac ?gtr|acgtr|acc|acoustic)\b/],
  ['keys', /\b(keys?|kbd|piano|pno|synth|nord|organ|rhodes)\b/],
  ['bass', /\b(bass|bs|bgtr)\b/],
  ['guitar', /\b(eg|gtr|guitar|elec)\b/],
  ['drums', /\b(drums?|kick|kik|snare|snr|oh|tom|hat|hh|cajon)\b/],
  ['room', /\b(room|amb|ambient|crowd|audience)\b/],
];

export function normalizeName(name) {
  return String(name || '')
    .replace(/([a-z])([0-9])/gi, '$1 $2')
    .replace(/([0-9])([a-z])/gi, '$1 $2')
    .replace(/[_\-./]+/g, ' ')
    .toLowerCase()
    .trim();
}

/** True for blank names and mixer defaults like "Ch01" / "CH 1" / "Aux". */
export function isDefaultName(name) {
  const n = normalizeName(name);
  return n === '' || /^(ch|chan|channel|in|input)? ?\d{1,2}$/.test(n) || /^aux( in)?$/.test(n);
}

export function classifyName(name) {
  if (isDefaultName(name)) return 'none';
  const n = normalizeName(name);
  for (const [role, re] of RULES) if (re.test(n)) return role;
  return 'unknown';
}

/** Detect "Keys L" / "Track R" style stereo halves. */
export function stereoSide(name) {
  const n = normalizeName(name);
  if (/\b(l|left)$/.test(n)) return 'L';
  if (/\b(r|right)$/.test(n)) return 'R';
  return null;
}
