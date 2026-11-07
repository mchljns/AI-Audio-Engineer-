// Minimal OSC 1.0 encoder/decoder: the subset the XR18 uses.
// Types: i (int32), f (float32), s (string), b (blob).

function pad4(n) {
  return (n + 3) & ~3;
}

function encodeString(str) {
  const raw = Buffer.from(str, 'utf8');
  const buf = Buffer.alloc(pad4(raw.length + 1)); // at least one NUL
  raw.copy(buf);
  return buf;
}

function encodeBlob(data) {
  const buf = Buffer.alloc(4 + pad4(data.length));
  buf.writeInt32BE(data.length, 0);
  Buffer.from(data).copy(buf, 4);
  return buf;
}

/**
 * Encode an OSC message.
 * args: array of { type: 'i'|'f'|'s'|'b', value } or bare JS values
 * (integers become 'i', other numbers 'f', strings 's', Buffers 'b').
 */
export function encodeMessage(address, args = []) {
  const typed = args.map(toTyped);
  const parts = [encodeString(address), encodeString(',' + typed.map((a) => a.type).join(''))];
  for (const a of typed) {
    switch (a.type) {
      case 'i': {
        const b = Buffer.alloc(4);
        b.writeInt32BE(a.value | 0, 0);
        parts.push(b);
        break;
      }
      case 'f': {
        const b = Buffer.alloc(4);
        b.writeFloatBE(a.value, 0);
        parts.push(b);
        break;
      }
      case 's':
        parts.push(encodeString(String(a.value)));
        break;
      case 'b':
        parts.push(encodeBlob(a.value));
        break;
      default:
        throw new Error(`Unsupported OSC type: ${a.type}`);
    }
  }
  return Buffer.concat(parts);
}

function toTyped(arg) {
  if (arg && typeof arg === 'object' && 'type' in arg) return arg;
  if (Buffer.isBuffer(arg)) return { type: 'b', value: arg };
  if (typeof arg === 'string') return { type: 's', value: arg };
  if (typeof arg === 'number') return Number.isInteger(arg) ? { type: 'i', value: arg } : { type: 'f', value: arg };
  throw new Error(`Cannot infer OSC type for ${arg}`);
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error('Unterminated OSC string');
  return { value: buf.toString('utf8', offset, end), next: pad4(end + 1) };
}

/** Decode an OSC message (bundles are not used by the XR18 and are rejected). */
export function decodeMessage(buf) {
  const addr = readString(buf, 0);
  if (addr.value.startsWith('#bundle')) throw new Error('OSC bundles not supported');
  const args = [];
  if (addr.next >= buf.length) return { address: addr.value, args };
  const tags = readString(buf, addr.next);
  if (!tags.value.startsWith(',')) return { address: addr.value, args };
  let off = tags.next;
  for (const t of tags.value.slice(1)) {
    switch (t) {
      case 'i':
        args.push({ type: 'i', value: buf.readInt32BE(off) });
        off += 4;
        break;
      case 'f':
        args.push({ type: 'f', value: buf.readFloatBE(off) });
        off += 4;
        break;
      case 's': {
        const s = readString(buf, off);
        args.push({ type: 's', value: s.value });
        off = s.next;
        break;
      }
      case 'b': {
        const len = buf.readInt32BE(off);
        off += 4;
        args.push({ type: 'b', value: buf.subarray(off, off + len) });
        off += pad4(len);
        break;
      }
      default:
        throw new Error(`Unsupported OSC type tag: ${t}`);
    }
  }
  return { address: addr.value, args };
}
