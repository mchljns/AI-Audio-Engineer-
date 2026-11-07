// Follow ProPresenter: when the operator puts up a song, the Set tab moves to that song.
//
// Uses ProPresenter 7's network API (7.9 and later): Settings → Network → Enable Network.
// Read-only: it only asks which presentation is live (GET /v1/presentation/current) and
// never controls ProPresenter. No password is involved.

import fs from 'node:fs';
import path from 'node:path';

const POLL_MS = 1000;
const TIMEOUT_MS = 1500;

/** Only computers on the local network: this must never become a way to make the Mac fetch arbitrary sites. */
export function validProHost(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (/^[a-z0-9-]{1,63}\.local$/.test(h)) return h;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return null;
  const local = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 127;
  return local ? h : null;
}

/** The presentation name in a /v1/presentation/current reply (shapes differ a little between versions). */
export function presentationName(json) {
  const p = json?.presentation;
  if (!p) return null;
  const name = p.id?.name ?? p.name ?? null;
  return typeof name === 'string' && name.trim() ? name.trim() : null;
}

/** The slide groups of a /v1/presentation/current reply, in order: [{ name, slides }]. */
export function presentationGroups(json) {
  const groups = json?.presentation?.groups;
  if (!Array.isArray(groups)) return [];
  return groups.map((g) => ({ name: String(g?.name ?? ''), slides: Array.isArray(g?.slides) ? g.slides.length : 0 }));
}

/** Which group a slide index falls in (slides counted through the groups in order). */
export function groupAt(groups, index) {
  let i = Number(index);
  if (!Number.isInteger(i) || i < 0) return null;
  for (const g of groups) {
    if (i < g.slides) return g.name;
    i -= g.slides;
  }
  return null;
}

/**
 * What kind of section a ProPresenter group name is: 'light' (verse, pre-chorus, intro,
 * instrumental: room for the lead vocal) or 'full' (chorus, bridge, tag, vamp, outro).
 */
export function sectionKind(name) {
  const n = String(name ?? '').toLowerCase();
  if (/pre[\s-]?chorus|verse|intro|instrumental|interlude|turnaround|^v\d/.test(n)) return 'light';
  if (/chorus|bridge|tag|vamp|outro|ending|refrain|^c\d|^b\d/.test(n)) return 'full';
  return null;
}

export class ProPresenter {
  constructor({ file, onPresentation = () => {}, onSection = () => {}, fetchImpl = globalThis.fetch } = {}) {
    this.onSection = onSection;
    this.file = file;
    this.onPresentation = onPresentation;
    this.fetch = fetchImpl;
    this.settings = { host: '', port: '', follow: false };
    try {
      this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* not set up yet */
    }
    this.state = { connected: false, presentation: null, error: null };
    this.timer = null;
    this.busy = false;
    this.lastName = null; // survives a dropout, so reconnecting doesn't undo a song the engineer picked
  }

  start() {
    this.timer = setInterval(() => this.poll(), POLL_MS);
    return this;
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Save the address and/or the follow switch. Throws a plain-English error for a bad address. */
  configure({ host, port, follow } = {}) {
    const next = { ...this.settings };
    if (host !== undefined || port !== undefined) {
      const h = host === undefined ? next.host : String(host).trim() === '' ? '' : validProHost(host);
      if (h === null) throw new Error("That address isn't a computer on this network. Use the IP address ProPresenter shows in Settings → Network (like 192.168.1.20).");
      const p = port === undefined ? next.port : String(port).trim();
      if (h && !/^\d{1,5}$/.test(p)) throw new Error('Enter the port number ProPresenter shows in Settings → Network.');
      if (h && (Number(p) < 1 || Number(p) > 65535)) throw new Error("That port number isn't valid.");
      next.host = h;
      next.port = h ? p : '';
    }
    if (follow !== undefined) next.follow = !!follow;
    if (!next.host) next.follow = false;
    this.settings = next;
    this.state = { connected: false, presentation: null, error: null };
    this.lastName = null; // switching on (or a new address) catches up with what's up now
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.settings));
    }
  }

  async poll() {
    const { host, port, follow } = this.settings;
    if (!host || !follow || this.busy) return;
    this.busy = true;
    try {
      const res = await this.fetch(`http://${host}:${port}/v1/presentation/current`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.status === 404) throw new Error('old');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json().catch(() => null);
      const name = presentationName(json);
      this.state = { connected: true, presentation: name, error: null, section: this.state.section ?? null };
      if (name && name !== this.lastName) {
        this.lastName = name;
        this.state.section = null;
        this.onPresentation(name);
      }
      // Which slide is live, and so which section of the song (Verse 2, Chorus…).
      const groups = presentationGroups(json);
      if (groups.length) {
        const r2 = await this.fetch(`http://${host}:${port}/v1/presentation/slide_index`, { signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
        const j2 = r2?.ok ? await r2.json().catch(() => null) : null;
        const idx = (j2?.presentation_index ?? j2?.presentation)?.index;
        const section = groupAt(groups, idx);
        if (section !== this.state.section) {
          this.state.section = section;
          this.onSection(section);
        }
      }
    } catch (e) {
      this.state = {
        connected: false,
        presentation: null,
        error:
          e.message === 'old'
            ? 'ProPresenter answered but has no network API. It needs ProPresenter 7.9 or later.'
            : `Can't reach ProPresenter at ${host}:${port}. In ProPresenter, check Settings → Network → Enable Network is on and the port matches, and that this Mac and the ProPresenter computer are on the same network.`,
      };
    } finally {
      this.busy = false;
    }
  }

  status() {
    return { host: this.settings.host, port: this.settings.port, follow: this.settings.follow, ...this.state };
  }
}
