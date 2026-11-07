// Walk-in music: controls Spotify (or Apple Music) on the booth Mac so nobody has to touch it.
//
// Uses AppleScript through `osascript`, the same way macOS shortcuts and remotes do. The first
// time, macOS asks "node wants to control Spotify": click OK. Nothing here changes the mixer;
// fading the walk-in channel up and down is the bridge's job.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import dns from 'node:dns/promises';

const POLL_MS = 2000;
const NET_CHECK_MS = 30000;
const SCRIPT_TIMEOUT_MS = 4000;

const APPS = {
  spotify: { app: 'Spotify', label: 'Spotify' },
  music: { app: 'Music', label: 'Apple Music' },
};

/** Turn a pasted Spotify link or URI into a Spotify URI, or null if it isn't one. */
export function toSpotifyUri(text) {
  const t = String(text ?? '').trim();
  let m = t.match(/^spotify:(playlist|album|track|artist|show):([A-Za-z0-9]{10,40})$/);
  if (m) return `spotify:${m[1]}:${m[2]}`;
  m = t.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|track|artist|show)\/([A-Za-z0-9]{10,40})/);
  if (m) return `spotify:${m[1]}:${m[2]}`;
  return null;
}

/** Quote a string for AppleScript. */
export function asString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function runOsascript(script) {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: SCRIPT_TIMEOUT_MS }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = String(stderr || '');
        reject(err);
      } else resolve(String(stdout).trim());
    });
  });
}

/** Builds the AppleScript for each action. Kept separate so it can be tested without a Mac. */
export function scriptFor(appKey, action, arg) {
  const app = APPS[appKey]?.app;
  if (!app) throw new Error(`Unknown music app: ${appKey}`);
  const tell = (body) => `tell application ${asString(app)} to ${body}`;
  switch (action) {
    case 'status':
      // Never launches the app just to check on it.
      return [
        `if application ${asString(app)} is running then`,
        `  tell application ${asString(app)}`,
        '    set st to (player state as string)',
        '    set nm to ""',
        '    set ar to ""',
        '    try',
        '      set nm to name of current track',
        '      set ar to artist of current track',
        '    end try',
        '    return st & "\\n" & nm & "\\n" & ar',
        '  end tell',
        'else',
        '  return "not running"',
        'end if',
      ].join('\n');
    case 'play':
      return tell('play');
    case 'pause':
      return tell('pause');
    case 'next':
      return tell('next track');
    case 'previous':
      return tell('previous track');
    case 'playList':
      if (appKey === 'spotify') {
        const uri = toSpotifyUri(arg);
        if (!uri) throw new Error('Not a Spotify playlist link');
        return tell(`play track ${asString(uri)}`);
      }
      return tell(`play playlist ${asString(arg)}`);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/** Plain-English help for the errors macOS gives. */
export function explainError(err, label) {
  const text = `${err?.stderr ?? ''} ${err?.message ?? ''}`;
  if (/-1743|Not authorized|not allowed to send/i.test(text))
    return `macOS hasn't allowed Mix Assistant to control ${label}. Open System Settings → Privacy & Security → Automation, find "node", and turn on ${label}.`;
  if (/-1728|Can.t get|-1708/i.test(text)) return `${label} couldn't play that. Check the playlist link opens in ${label} on the Mac.`;
  if (/-600|isn.t running|not running/i.test(text)) return `${label} isn't open on the Mac. Open it once, then try again.`;
  if (/ETIMEDOUT|timed out|SIGTERM/i.test(text)) return `${label} didn't answer in time. It may be starting up: try again in a few seconds.`;
  if (/ENOENT/.test(text)) return 'Music control only works on the booth Mac.';
  return `${label} didn't respond as expected.`;
}

export class MusicController extends EventEmitter {
  /**
   * appKey: 'spotify' | 'music'. `runner` runs AppleScript (injected in tests and practice mode).
   */
  constructor({ appKey = 'spotify', runner = runOsascript, checkInternet = defaultInternetCheck, onAlert = () => {} } = {}) {
    super();
    this.appKey = APPS[appKey] ? appKey : 'spotify';
    this.label = APPS[this.appKey].label;
    this.runner = runner;
    this.checkInternet = checkInternet;
    this.onAlert = onAlert;
    this.state = { available: process.platform === 'darwin' || runner !== runOsascript, running: false, playing: false, track: '', artist: '', internet: null, error: null };
    this.timers = [];
    this.lastErrorAt = 0;
  }

  start() {
    if (!this.state.available) return this;
    this.#poll();
    this.timers.push(setInterval(() => this.#poll(), POLL_MS));
    this.#netCheck();
    this.timers.push(setInterval(() => this.#netCheck(), NET_CHECK_MS));
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.timers = [];
  }

  async #poll() {
    try {
      const out = await this.runner(scriptFor(this.appKey, 'status'));
      if (out === 'not running') Object.assign(this.state, { running: false, playing: false, track: '', artist: '' });
      else {
        const [st, track, artist] = out.split('\n');
        Object.assign(this.state, { running: true, playing: /playing/i.test(st), track: track ?? '', artist: artist ?? '' });
      }
      this.state.error = null;
    } catch (err) {
      this.state.error = explainError(err, this.label);
    }
  }

  async #netCheck() {
    try {
      this.state.internet = await this.checkInternet();
    } catch {
      this.state.internet = false;
    }
  }

  /** Run a player action. Returns true if it worked. */
  async command(action, arg) {
    if (!this.state.available) {
      this.#fail('Music control only works on the booth Mac.');
      return false;
    }
    let script;
    try {
      script = scriptFor(this.appKey, action, arg);
    } catch (err) {
      this.#fail(err.message === 'Not a Spotify playlist link' ? "That doesn't look like a Spotify playlist link. In Spotify, use Share → Copy link to playlist." : err.message);
      return false;
    }
    try {
      await this.runner(script);
      await this.#poll();
      return true;
    } catch (err) {
      this.#fail(explainError(err, this.label));
      return false;
    }
  }

  #fail(message) {
    this.state.error = message;
    // Don't repeat the same alert every few seconds.
    if (Date.now() - this.lastErrorAt > 10000 || this.lastMessage !== message) this.onAlert({ level: 'warn', source: 'music', message });
    this.lastErrorAt = Date.now();
    this.lastMessage = message;
  }

  status() {
    return { app: this.appKey, label: this.label, ...this.state };
  }
}

/** Is the internet reachable (for streaming)? A DNS lookup is quick and needs no permission. */
async function defaultInternetCheck() {
  try {
    await Promise.race([dns.lookup('api.spotify.com'), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
    return true;
  } catch {
    return false;
  }
}

/** A pretend Spotify for practice mode and tests. */
export function fakePlayer() {
  const st = { running: true, playing: false, i: 0 };
  const tracks = [
    ['Walk-in Song One', 'Practice Artist'],
    ['Walk-in Song Two', 'Practice Artist'],
    ['Walk-in Song Three', 'Practice Artist'],
  ];
  const calls = [];
  const runner = async (script) => {
    calls.push(script);
    if (script.includes('player state')) return `${st.playing ? 'playing' : 'paused'}\n${tracks[st.i][0]}\n${tracks[st.i][1]}`;
    if (/to play track/.test(script)) {
      st.i = 0;
      st.playing = true;
    } else if (/to play$/.test(script)) st.playing = true;
    else if (/to pause$/.test(script)) st.playing = false;
    else if (/next track$/.test(script)) st.i = (st.i + 1) % tracks.length;
    else if (/previous track$/.test(script)) st.i = (st.i + tracks.length - 1) % tracks.length;
    return '';
  };
  return { runner, calls, st };
}
