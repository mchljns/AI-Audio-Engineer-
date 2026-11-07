// Name the mixer's channels after this week's people ("Sarah Vox", "Ann Keys L"), so X Air and
// the app agree on who is where.
//
// The app works out what a channel is from its name, so a name is only used if it reads back as
// the right kind of channel: "Ann Vox" would read as an announcement mic ("ann"), so it becomes
// "Vox A." instead. Click and guide channels are never renamed.

import { classifyName, stereoSide } from './roles.js';

const TAGS = { vocal: 'Vox', acoustic: 'AG', keys: 'Keys', electric: 'EG', bass: 'Bass', drums: 'Drums', other: 'Inst' };
const ROLE_OF = { vocal: 'vocal', acoustic: 'acoustic', keys: 'keys', electric: 'guitar', bass: 'bass', drums: 'drums', other: null };
const MAX = 12; // X Air channel names are up to 12 characters

/** The name for a person's channel (side 'L'/'R' for a stereo pair), checked to read back right. */
export function channelName(personName, instrument, side = null) {
  const tag = TAGS[instrument] ?? 'Inst';
  const want = ROLE_OF[instrument];
  const tail = side ? ` ${side}` : '';
  const first = String(personName ?? '').trim().split(/\s+/)[0].replace(/[^\p{L}\p{N}'-]/gu, '');
  const ok = (n) => n.length <= MAX && (!want || classifyName(n) === want) && (stereoSide(n) ?? null) === (side ?? null);
  const room = MAX - tag.length - tail.length - 1;
  const candidates = [first && `${first.slice(0, room)} ${tag}${tail}`, first && `${tag} ${first[0].toUpperCase()}.${tail}`, `${tag}${tail}`];
  return candidates.find((n) => n && ok(n)) ?? `${tag}${tail}`;
}
