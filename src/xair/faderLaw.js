// Behringer X32/X Air fader law: OSC float 0..1 <-> dB (-inf..+10).

export function floatToDb(f) {
  if (f <= 0) return -Infinity;
  if (f >= 0.5) return f * 40 - 30;
  if (f >= 0.25) return f * 80 - 50;
  if (f >= 0.0625) return f * 160 - 70;
  return f * 480 - 90;
}

export function dbToFloat(db) {
  if (db === -Infinity || db <= -90) return 0;
  let f;
  if (db >= -10) f = (db + 30) / 40;
  else if (db >= -30) f = (db + 50) / 80;
  else if (db >= -60) f = (db + 70) / 160;
  else f = (db + 90) / 480;
  // The mixer quantises faders to 1024 steps.
  return Math.min(1, Math.max(0, Math.round(f * 1023) / 1023));
}

export function formatDb(db) {
  if (db === -Infinity || db <= -90) return '-∞';
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)}`;
}
