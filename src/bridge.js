// The booth bridge: talks to the XR18 over OSC/UDP and serves the web app.
//
//   npm start                      # find the XR18 on the network automatically
//   MIXER_HOST=192.168.1.50 npm start
//   npm run dev                    # practice mode: bridge + simulated XR18

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { XAirClient, discoverMixers } from './xair/client.js';
import { paths, STRIP_IDS, DCA_COUNT } from './xair/addresses.js';
import { dbToFloat, floatToDb } from './xair/faderLaw.js';
import { MixerState } from './mixerState.js';
import { RoleStore, buildInventory, resolveRole } from './inventory.js';
import { ClickGuard, LockStore } from './clickGuard.js';
import { FadeEngine } from './fades.js';
import { AutoMix } from './automix.js';
import { ROLES } from './roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const RESYNC_MS = 30000;
const REDISCOVER_AFTER_MS = 20000;
const PUSH_MS = 100;
const MAX_ALERTS = 50;
const SEARCH_LOG_EVERY_MS = 5 * 60 * 1000;
const PIN_LENGTH = 6;
const PIN_MAX_TRIES = 5;
const PIN_LOCKOUT_MS = 60 * 1000;
const UNUSED_SETTLE_MS = 15000;

export function loadConfig() {
  let file = {};
  // Installed copies keep config.json in the data folder so updates never overwrite it.
  const candidates = [process.env.DATA_DIR && path.join(process.env.DATA_DIR, 'config.json'), path.join(ROOT, 'config.json')];
  const found = candidates.find((f) => f && fs.existsSync(f));
  if (found) {
    try {
      file = JSON.parse(fs.readFileSync(found, 'utf8'));
    } catch (err) {
      console.error(`Couldn't read ${found}: ${err.message}. Using default settings.`);
    }
  }
  return {
    mixerHost: process.env.MIXER_HOST || file.mixerHost || 'auto',
    mixerName: file.mixerName || null, // pick this mixer if several answer
    mixerPort: Number(process.env.MIXER_PORT || file.mixerPort || 10024),
    httpPort: Number(process.env.PORT || file.httpPort || 8080),
    walkinFadeSeconds: Number(file.walkinFadeSeconds || 8),
    dataDir: process.env.DATA_DIR || file.dataDir || path.join(ROOT, 'data'),
    keepAwake: file.keepAwake !== false,
    pin: file.pin === false ? false : file.pin ? String(file.pin) : null, // null = generate one
    trustLocalhost: file.trustLocalhost !== false,
    protectedBuses: Array.isArray(file.protectedBuses) ? file.protectedBuses : null,
    monitorBuses: Array.isArray(file.monitorBuses) ? file.monitorBuses : null,
    allowedHosts: Array.isArray(file.allowedHosts) ? file.allowedHosts : [],
    automix: typeof file.automix === 'object' && file.automix ? file.automix : {},
  };
}

// Errors that mean macOS (or a firewall) is blocking this program from the local network.
const BLOCKED_CODES = new Set(['EHOSTUNREACH', 'EPERM', 'EACCES', 'ENETUNREACH']);
const BLOCKED_HELP =
  "This Mac isn't letting Mix Assistant reach the local network. Open System Settings → Privacy & Security → Local Network and turn on \"node\" (and Terminal), then restart Mix Assistant. If you aren't on the mixer's network, connect to it.";

export function lanAddresses() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a.address);
  }
  return out;
}

function isLoopback(addr = '') {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function hostOnly(hostHeader = '') {
  const h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.split(':')[0];
}

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

export class Bridge {
  constructor(config) {
    this.config = config;
    this.state = new MixerState();
    this.roleStore = new RoleStore(path.join(config.dataDir, 'roles.json'));
    this.lockStore = new LockStore(path.join(config.dataDir, 'locks.json'));
    this.settingsFile = path.join(config.dataDir, 'settings.json');
    this.settings = { walkinLevels: {}, automix: {} };
    try {
      this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      /* first run */
    }
    // PIN for devices other than this computer. Generated once and kept.
    if (config.pin === false) this.pin = null;
    else if (config.pin) this.pin = config.pin;
    else {
      if (!this.settings.pin || String(this.settings.pin).length < PIN_LENGTH) {
        this.settings.pin = String(crypto.randomInt(0, 10 ** PIN_LENGTH)).padStart(PIN_LENGTH, '0');
        this.#saveSettings();
      }
      this.pin = this.settings.pin;
    }
    this.pinTries = new Map(); // ip -> { fails, until }
    this.alerts = [];
    this.alertSeq = 0;
    this.status = { connected: false, mixer: null, host: null, searching: false, version: VERSION };
    this.timers = [];
    this.stopped = false;
  }

  async start() {
    this.#startHttp();
    this.timers.push(setInterval(() => this.#push(), PUSH_MS));
    if (this.config.keepAwake && process.platform === 'darwin') {
      // Keep the Mac from idle-sleeping while the bridge runs.
      this.caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
      this.caffeinate.on('error', () => {});
    }
    await this.#connectMixer();
    return this;
  }

  stop() {
    this.stopped = true;
    this.timers.forEach(clearInterval);
    this.fades?.stopAll();
    this.automix?.stop();
    this.client?.stop();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.server?.close();
    this.caffeinate?.kill();
  }

  // ---------- mixer ----------

  async #discoverOnce() {
    let blocked = 0;
    const found = await discoverMixers({
      port: this.config.mixerPort,
      onSendError: (err) => BLOCKED_CODES.has(err.code) && blocked++,
    });
    if (blocked && !found.length) this.#networkBlocked();
    const pick = this.config.mixerName ? found.find((m) => m.name === this.config.mixerName) : found[0];
    if (pick && found.length > 1) console.log(`Found ${found.length} mixers: ${found.map((m) => `${m.name} (${m.host})`).join(', ')}`);
    return pick ?? null;
  }

  async #findMixer() {
    this.status.searching = true;
    console.log('Looking for an XR18 on the network…');
    let lastLog = Date.now();
    while (!this.stopped) {
      const pick = await this.#discoverOnce();
      if (pick) {
        console.log(`Using ${pick.name} (${pick.model}, firmware ${pick.firmware}) at ${pick.host}`);
        this.status.searching = false;
        return pick.host;
      }
      if (Date.now() - lastLog > SEARCH_LOG_EVERY_MS) {
        console.log('Still looking for the mixer. Is this computer on the same network as the XR18?');
        lastLog = Date.now();
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    return null;
  }

  async #connectMixer() {
    const host = this.config.mixerHost === 'auto' ? await this.#findMixer() : this.config.mixerHost;
    if (!host) return;
    this.status.host = host;

    this.client = new XAirClient({ host, port: this.config.mixerPort });
    this.guard = new ClickGuard({
      state: this.state,
      client: this.client,
      roleStore: this.roleStore,
      lockStore: this.lockStore,
      protectedBuses: this.config.protectedBuses,
      monitorBuses: this.config.monitorBuses,
      onAlert: (a) => this.alert(a),
    });
    this.fades = new FadeEngine({ state: this.state, client: this.client });
    this.automix = new AutoMix({
      state: this.state,
      client: this.client,
      roleStore: this.roleStore,
      isLocked: (id) => this.#lockedIds().includes(id) || !!this.fades?.isFading(id),
      stateFile: path.join(this.config.dataDir, 'automix-state.json'),
      settings: { ...(this.config.automix ?? {}), ...(this.settings.automix ?? {}) },
      onAlert: (a) => this.alert(a),
    });
    this.automix.on('mode', ({ mode, auto }) => {
      const label = { walkin: 'Walk-in', worship: 'Worship', talkover: 'Talking over music', speaking: 'Speaking' }[mode] ?? mode;
      this.alert({ level: 'info', source: 'automix', message: `${auto ? 'Switched' : 'Set'} to ${label}.` });
    });

    this.client.on('message', (msg) => this.state.apply(msg));
    this.state.on('meters', () => {
      if (this.automix.enabled) {
        try {
          this.automix.tick();
        } catch (err) {
          console.error('Auto-mix error:', err.message);
        }
      }
    });
    this.client.on('connected', (info) => {
      this.status.connected = true;
      this.status.mixer = info;
      this.disconnectedAt = 0;
      console.log(`Connected to mixer at ${this.client.host}`);
      this.alert({ level: 'ok', source: 'connection', message: 'Connected to the mixer.' });
      this.#resync(() => {
        if (!this.automix.enabled) this.automix.start();
      });
    });
    this.client.on('disconnected', () => {
      this.status.connected = false;
      this.disconnectedAt = Date.now();
      this.fades.stopAll();
      this.alert({ level: 'warn', source: 'connection', message: 'Lost contact with the mixer. Retrying…' });
    });
    this.client.on('error', (err) => {
      if (BLOCKED_CODES.has(err.code)) this.#networkBlocked();
      else console.error('Mixer link error:', err.message);
    });

    // Enforce the click/guide lock the instant anything relevant changes.
    this.state.on('change', ({ id, field, busName }) => {
      if (busName) this.guard.enforce();
      else if (id && (field === 'lr' || field === 'send' || field === 'name')) this.guard.enforce(id);
    });

    await this.client.start();
    // Backup: re-read everything periodically, then re-check the lock.
    this.timers.push(setInterval(() => this.status.connected && this.#resync(), RESYNC_MS));
    // If the mixer has been gone a while, it may have a new address: look for it again.
    if (this.config.mixerHost === 'auto') {
      this.timers.push(
        setInterval(async () => {
          if (this.status.connected || !this.disconnectedAt || Date.now() - this.disconnectedAt < REDISCOVER_AFTER_MS || this.rediscovering) return;
          this.rediscovering = true;
          try {
            const pick = await this.#discoverOnce();
            if (pick && pick.host !== this.client.host) {
              console.log(`Mixer found at a new address: ${pick.host}`);
              await this.client.setHost(pick.host);
              this.status.host = pick.host;
            }
          } finally {
            this.rediscovering = false;
          }
        }, 5000),
      );
    }
  }

  #networkBlocked() {
    if (this.blockedWarnedAt && Date.now() - this.blockedWarnedAt < SEARCH_LOG_EVERY_MS) return;
    this.blockedWarnedAt = Date.now();
    this.alert({ level: 'danger', source: 'connection', message: BLOCKED_HELP });
  }

  #resync(then) {
    this.client.syncAll().then(() =>
      setTimeout(() => {
        if (this.stopped) return;
        this.guard.enforce();
        then?.();
      }, 500),
    );
  }

  alert({ level = 'info', source = 'app', message, id }) {
    const a = { alertId: ++this.alertSeq, at: Date.now(), level, source, message, strip: id ?? null };
    this.alerts.unshift(a);
    this.alerts.length = Math.min(this.alerts.length, MAX_ALERTS);
    console.log(`[${level}] ${message}`);
    return a;
  }

  #lockedIds() {
    return this.guard ? this.guard.lockedStrips() : [];
  }

  #unusedRows() {
    const inv = buildInventory(this.state, this.roleStore, Date.now(), this.#lockedIds());
    return inv.rows.filter((r) => r.status === 'unused' && r.on && !r.locked);
  }

  // ---------- commands from the web app ----------

  handleCommand(cmd) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return;
    if (!this.client) return; // still searching for the mixer
    // Never act on a mixer we can't reach: the screen would show changes that didn't happen.
    const offlineOk = new Set(['dismissAlert', 'clearAlerts']);
    if (!this.status.connected && !offlineOk.has(cmd.type)) {
      this.alert({ level: 'warn', source: 'connection', message: "The mixer isn't connected, so that change wasn't made." });
      return;
    }
    const id = cmd.id === undefined || cmd.id === null ? null : String(cmd.id);
    if (id !== null && !STRIP_IDS.includes(id)) return;
    const s = id ? this.state.strips[id] : null;
    const n = Number.isInteger(cmd.n) && cmd.n >= 1 && cmd.n <= DCA_COUNT ? cmd.n : null;

    switch (cmd.type) {
      case 'setFader': {
        if (!s) return;
        let v;
        if (isFiniteNum(cmd.value)) v = Math.min(1, Math.max(0, cmd.value));
        else if (isFiniteNum(cmd.db)) v = dbToFloat(cmd.db);
        else return;
        this.fades.cancel(id);
        this.automix.humanFader(id, v);
        s.fader = v;
        s.faderDb = floatToDb(v);
        this.client.setFloat(paths.fader(id), v);
        return;
      }
      case 'setOn':
        if (!s || typeof cmd.on !== 'boolean') return;
        s.on = cmd.on;
        this.client.setInt(paths.on(id), cmd.on ? 1 : 0);
        return;
      case 'setLr': {
        if (!s || typeof cmd.lr !== 'boolean') return;
        if (cmd.lr && this.#lockedIds().includes(id)) {
          this.alert({ level: 'warn', source: 'click-guard', id, message: `${s.name || this.#label(id)} is locked to monitors and can't go to the main speakers.` });
          return;
        }
        s.lr = cmd.lr;
        this.client.setInt(paths.lr(id), cmd.lr ? 1 : 0);
        this.guard.enforce(id);
        return;
      }
      case 'setRole':
        if (!s) return;
        if (cmd.role && !ROLES[cmd.role]) return;
        this.roleStore.set(id, s.name, cmd.role || null);
        this.guard.roleChanged(id);
        this.guard.enforce(id);
        return;
      case 'releaseLock':
        if (!s) return;
        this.guard.release(id);
        this.guard.enforce(id); // re-locks at once if the name still says click/guide
        this.alert({ level: 'info', source: 'click-guard', id, message: `${this.#label(id)} is no longer locked to monitors.` });
        return;
      case 'walkin':
        return this.#walkin(cmd.action, cmd.seconds);
      case 'muteUnused': {
        // Only safe once every name has loaded and meters have flowed long enough to trust "no signal".
        if (!this.state.settled(UNUSED_SETTLE_MS)) {
          this.alert({ level: 'warn', source: 'inventory', message: 'Still checking channels. Try again in a few seconds.' });
          return;
        }
        const wanted = new Set(Array.isArray(cmd.ids) ? cmd.ids.map(String) : []);
        const targets = this.#unusedRows().filter((r) => wanted.has(r.id));
        for (const r of targets) {
          this.state.strips[r.id].on = false;
          this.client.setInt(paths.on(r.id), 0);
        }
        this.alert({
          level: 'ok',
          source: 'inventory',
          message: targets.length
            ? `Muted ${targets.length} unused channel${targets.length > 1 ? 's' : ''}: ${targets.map((r) => r.label).join(', ')}.`
            : 'No open unused channels to mute.',
        });
        return;
      }
      case 'setDcaFader': {
        const d = n && this.state.dcas[n];
        if (!d) return;
        if (isFiniteNum(cmd.value)) d.fader = Math.min(1, Math.max(0, cmd.value));
        else if (isFiniteNum(cmd.db)) d.fader = dbToFloat(cmd.db);
        else return;
        d.faderDb = floatToDb(d.fader);
        this.client.setFloat(paths.dcaFader(n), d.fader);
        return;
      }
      case 'setDcaOn': {
        const d = n && this.state.dcas[n];
        if (!d || typeof cmd.on !== 'boolean') return;
        d.on = cmd.on;
        this.client.setInt(paths.dcaOn(n), cmd.on ? 1 : 0);
        return;
      }
      case 'setMode':
        this.automix.setMode(cmd.mode === 'auto' ? null : cmd.mode);
        return;
      case 'automix': {
        const updated = this.automix.update(cmd.settings ?? {});
        this.settings.automix = {
          speechAutomix: updated.speechAutomix,
          duckMusic: updated.duckMusic,
          muteSingersWhenSpeaking: updated.muteSingersWhenSpeaking,
          autoModes: updated.autoModes,
          duckDb: updated.duckDb,
        };
        this.#saveSettings();
        return;
      }
      case 'dismissAlert':
        this.alerts = this.alerts.filter((a) => a.alertId !== cmd.alertId);
        return;
      case 'clearAlerts':
        this.alerts = [];
        return;
      default:
        return;
    }
  }

  #label(id) {
    return id === 'aux' ? 'Aux 17/18' : `Ch ${id}`;
  }

  #walkinStrips() {
    return STRIP_IDS.filter((id) => resolveRole(this.state.strips[id], this.roleStore).role === 'walkin');
  }

  #walkin(action, seconds) {
    if (action !== 'out' && action !== 'in') return;
    const ids = this.#walkinStrips();
    if (!ids.length) {
      this.alert({ level: 'warn', source: 'walkin', message: 'No walk-in music channel found. Name it "Walk-in" or set its role.' });
      return;
    }
    const secs = Math.min(60, Math.max(0.2, isFiniteNum(seconds) ? seconds : this.config.walkinFadeSeconds));
    const ms = secs * 1000;
    for (const id of ids) {
      const s = this.state.strips[id];
      if (action === 'out') {
        if (s.on && s.faderDb > -60) this.settings.walkinLevels[id] = s.faderDb;
        this.fades.fade(id, -Infinity, ms, { muteAtEnd: true });
      } else {
        const target = this.settings.walkinLevels[id] ?? -10;
        if (!s.on) {
          // Start from silence so unmuting doesn't blast at the old fader level.
          s.fader = 0;
          this.client.setFloat(paths.fader(id), 0);
        }
        this.fades.fade(id, target, ms, { unmuteFirst: true });
      }
    }
    this.#saveSettings();
    this.alert({
      level: 'info',
      source: 'walkin',
      message: action === 'out' ? `Fading out walk-in music over ${secs} s.` : `Bringing up walk-in music over ${secs} s.`,
    });
  }

  #saveSettings() {
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
      fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    } catch (err) {
      console.error("Couldn't save settings:", err.message);
    }
  }

  // ---------- web app ----------

  snapshot({ local = false } = {}) {
    const lockedIds = this.#lockedIds();
    const inv = buildInventory(this.state, this.roleStore, Date.now(), lockedIds);
    return {
      type: 'state',
      status: this.status,
      inventory: inv,
      unusedReady: this.state.settled(UNUSED_SETTLE_MS),
      unused: this.state.settled(UNUSED_SETTLE_MS) ? this.#unusedRows().map((r) => ({ id: r.id, label: r.label })) : [],
      clickGuard: this.guard ? this.guard.status() : { locked: [], allSafe: true, unsure: [], protectedBuses: [], buses: [] },
      automix: this.automix ? this.automix.status() : null,
      dcas: Object.values(this.state.dcas),
      walkin: this.#walkinStrips().map((id) => ({ id, fading: !!this.fades?.isFading(id), on: this.state.strips[id].on })),
      alerts: this.alerts.slice(0, 20),
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
      // Only this computer's own screen is shown the PIN, so volunteers can read it off the Mac.
      pin: local ? this.pin : undefined,
      addresses: local && this.boundPort ? lanAddresses().map((ip) => `http://${ip}:${this.boundPort}`) : undefined,
    };
  }

  #json(obj) {
    return JSON.stringify(obj, (k, v) => (v === -Infinity ? -999 : v));
  }

  #push() {
    if (!this.wss || this.wss.clients.size === 0) return;
    let remote = null;
    let local = null;
    for (const ws of this.wss.clients) {
      if (ws.readyState !== 1 || !ws.authed) continue;
      try {
        if (ws.isLocal) ws.send((local ??= this.#json(this.snapshot({ local: true }))));
        else ws.send((remote ??= this.#json(this.snapshot())));
      } catch (err) {
        console.error('Update failed:', err.message);
      }
    }
  }

  #checkPin(ip, pin) {
    const now = Date.now();
    const t = this.pinTries.get(ip) ?? { fails: 0, until: 0 };
    if (t.until > now) return { ok: false, retryIn: Math.ceil((t.until - now) / 1000) };
    if (typeof pin === 'string' && pin.length === this.pin.length && crypto.timingSafeEqual(Buffer.from(pin), Buffer.from(this.pin))) {
      this.pinTries.delete(ip);
      return { ok: true };
    }
    t.fails++;
    if (t.fails >= PIN_MAX_TRIES) {
      t.fails = 0;
      t.until = now + PIN_LOCKOUT_MS;
    }
    this.pinTries.set(ip, t);
    return { ok: false, retryIn: t.until > now ? Math.ceil((t.until - now) / 1000) : 0 };
  }

  /** Requests must name this computer (stops DNS-rebinding tricks). */
  #hostAllowed(req) {
    const h = hostOnly(req.headers.host);
    if (!h) return false;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (lanAddresses().includes(h)) return true;
    if (os.hostname().toLowerCase() === h || `${os.hostname().toLowerCase()}.local` === h) return true;
    return (this.config.allowedHosts ?? []).map((x) => String(x).toLowerCase()).includes(h);
  }

  /** WebSocket connections must come from this app's own pages, not another website open in the browser. */
  #originAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true; // not a browser
    try {
      return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
    } catch {
      return false;
    }
  }

  #startHttp() {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
    this.server = http.createServer((req, res) => {
      try {
        this.#serve(req, res, types);
      } catch (err) {
        if (!res.headersSent) res.writeHead(400);
        res.end('Bad request');
      }
    });
    this.server.on('clientError', (err, socket) => socket.destroy());
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.config.httpPort} is already in use. Is Mix Assistant already running?`);
        process.exitCode = 1;
        this.stop();
      } else console.error('Web server error:', err.message);
    });

    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws',
      maxPayload: 16 * 1024,
      verifyClient: ({ req }) => this.#hostAllowed(req) && this.#originAllowed(req),
    });
    this.wss.on('error', (err) => console.error('WebSocket server error:', err.message));
    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
      ws.on('error', () => ws.terminate());
      ws.isLocal = this.config.trustLocalhost && isLoopback(ip);
      ws.authed = !this.pin || ws.isLocal;
      ws.send(JSON.stringify(ws.authed ? { type: 'hello', authed: true } : { type: 'auth-required' }));
      ws.on('message', (data) => {
        let cmd;
        try {
          cmd = JSON.parse(data);
        } catch {
          return;
        }
        if (!cmd || typeof cmd !== 'object') return;
        if (cmd.type === 'auth') {
          const r = ws.authed ? { ok: true } : this.#checkPin(ip, cmd.pin);
          ws.authed = r.ok;
          ws.send(JSON.stringify(r.ok ? { type: 'hello', authed: true } : { type: 'auth-failed', retryIn: r.retryIn }));
          return;
        }
        if (!ws.authed) return;
        try {
          this.handleCommand(cmd);
        } catch (err) {
          console.error('Command failed:', err.message);
        }
      });
    });

    this.server.listen(this.config.httpPort, '0.0.0.0', () => {
      this.boundPort = this.server.address().port;
      console.log(`\nMix Assistant ${VERSION}`);
      console.log('Open the app on any iPad, phone or computer on this network:');
      console.log(`  http://localhost:${this.boundPort}  (this computer)`);
      for (const ip of lanAddresses()) console.log(`  http://${ip}:${this.boundPort}`);
      if (this.pin) console.log(`PIN for other devices: ${this.pin}`);
      console.log('');
    });
  }

  #serve(req, res, types) {
    if (!this.#hostAllowed(req)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/state') {
      const local = this.config.trustLocalhost && isLoopback(req.socket.remoteAddress);
      if (this.pin && !local && !this.#checkPin(req.socket.remoteAddress, url.searchParams.get('pin')).ok) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end('{"error":"PIN required"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(this.#json(this.snapshot({ local })));
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    let rel;
    try {
      rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    } catch {
      rel = '';
    }
    const file = path.resolve(PUBLIC, rel);
    if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bridge = new Bridge(loadConfig());
  bridge.start();
  const shutdown = () => {
    bridge.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', (err) => {
    // Last line of defence: log it and let launchd restart us cleanly.
    console.error('Unexpected error:', err);
    process.exit(1);
  });
}
