// The booth bridge: talks to the XR18 over OSC/UDP and serves the web app.
//
//   npm start                      # find the XR18 on the network automatically
//   MIXER_HOST=192.168.1.50 npm start
//   npm run dev                    # bridge + simulated XR18

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { XAirClient, discoverMixers } from './xair/client.js';
import { paths, STRIP_IDS } from './xair/addresses.js';
import { dbToFloat, floatToDb } from './xair/faderLaw.js';
import { MixerState } from './mixerState.js';
import { RoleStore, buildInventory, resolveRole } from './inventory.js';
import { ClickGuard, LockStore } from './clickGuard.js';
import { FadeEngine } from './fades.js';
import { ROLES } from './roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const RESYNC_MS = 30000;
const PUSH_MS = 100;
const MAX_ALERTS = 50;
const SEARCH_LOG_EVERY_MS = 5 * 60 * 1000;
const PIN_MAX_TRIES = 5;
const PIN_LOCKOUT_MS = 60 * 1000;

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

export class Bridge {
  constructor(config) {
    this.config = config;
    this.state = new MixerState();
    this.roleStore = new RoleStore(path.join(config.dataDir, 'roles.json'));
    this.lockStore = new LockStore(path.join(config.dataDir, 'locks.json'));
    this.settingsFile = path.join(config.dataDir, 'settings.json');
    this.settings = { walkinLevels: {} };
    try {
      this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      /* first run */
    }
    // PIN for devices other than this computer. Generated once and kept.
    if (config.pin === false) this.pin = null;
    else if (config.pin) this.pin = config.pin;
    else {
      if (!this.settings.pin) {
        this.settings.pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
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
    this.client?.stop();
    for (const ws of this.wss?.clients ?? []) ws.terminate();
    this.wss?.close();
    this.server?.close();
    this.caffeinate?.kill();
  }

  // ---------- mixer ----------

  async #findMixer() {
    this.status.searching = true;
    console.log('Looking for an XR18 on the network…');
    let lastLog = Date.now();
    while (!this.stopped) {
      let blocked = 0;
      const found = await discoverMixers({
        port: this.config.mixerPort,
        onSendError: (err) => BLOCKED_CODES.has(err.code) && blocked++,
      });
      if (blocked && !found.length) this.#networkBlocked();
      const pick = this.config.mixerName ? found.find((m) => m.name === this.config.mixerName) : found[0];
      if (pick) {
        if (found.length > 1) console.log(`Found ${found.length} mixers: ${found.map((m) => `${m.name} (${m.host})`).join(', ')}`);
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
      onAlert: (a) => this.alert(a),
    });
    this.fades = new FadeEngine({ state: this.state, client: this.client });

    this.client.on('message', (msg) => this.state.apply(msg));
    this.client.on('connected', (info) => {
      this.status.connected = true;
      this.status.mixer = info;
      console.log(`Connected to mixer at ${host}`);
      this.alert({ level: 'ok', source: 'connection', message: 'Connected to the mixer.' });
      this.#resync();
    });
    this.client.on('disconnected', () => {
      this.status.connected = false;
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
  }

  #networkBlocked() {
    if (this.blockedWarnedAt && Date.now() - this.blockedWarnedAt < SEARCH_LOG_EVERY_MS) return;
    this.blockedWarnedAt = Date.now();
    this.alert({ level: 'danger', source: 'connection', message: BLOCKED_HELP });
  }

  #resync() {
    this.client.syncAll().then(() => setTimeout(() => !this.stopped && this.guard.enforce(), 500));
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

  // ---------- commands from the web app ----------

  handleCommand(cmd) {
    if (!this.client) return; // still searching for the mixer
    const s = cmd.id != null ? this.state.strips[cmd.id] : null;
    switch (cmd.type) {
      case 'setFader': {
        if (!s) return;
        this.fades.cancel(cmd.id);
        const v = typeof cmd.value === 'number' ? Math.min(1, Math.max(0, cmd.value)) : dbToFloat(cmd.db);
        s.fader = v;
        s.faderDb = floatToDb(v);
        this.client.setFloat(paths.fader(cmd.id), v);
        return;
      }
      case 'setOn':
        if (!s) return;
        s.on = !!cmd.on;
        this.client.setInt(paths.on(cmd.id), cmd.on ? 1 : 0);
        return;
      case 'setLr': {
        if (!s) return;
        if (cmd.lr && this.#lockedIds().includes(cmd.id)) {
          this.alert({ level: 'warn', source: 'click-guard', id: cmd.id, message: `${s.name || `Ch ${cmd.id}`} is locked to monitors and can't go to the main speakers.` });
          return;
        }
        s.lr = !!cmd.lr;
        this.client.setInt(paths.lr(cmd.id), cmd.lr ? 1 : 0);
        return;
      }
      case 'setRole':
        if (!s) return;
        if (cmd.role && !ROLES[cmd.role]) return;
        this.roleStore.set(cmd.id, s.name, cmd.role || null);
        this.guard.roleChanged(cmd.id);
        this.guard.enforce(cmd.id);
        return;
      case 'walkin':
        return this.#walkin(cmd.action, cmd.seconds);
      case 'muteUnused': {
        const inv = buildInventory(this.state, this.roleStore, Date.now(), this.#lockedIds());
        const targets = inv.rows.filter((r) => r.status === 'unused' && r.on && !r.locked);
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
        const d = this.state.dcas[cmd.n];
        if (!d) return;
        d.fader = typeof cmd.value === 'number' ? Math.min(1, Math.max(0, cmd.value)) : dbToFloat(cmd.db);
        d.faderDb = floatToDb(d.fader);
        this.client.setFloat(paths.dcaFader(cmd.n), d.fader);
        return;
      }
      case 'setDcaOn': {
        const d = this.state.dcas[cmd.n];
        if (!d) return;
        d.on = !!cmd.on;
        this.client.setInt(paths.dcaOn(cmd.n), cmd.on ? 1 : 0);
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

  #walkinStrips() {
    return STRIP_IDS.filter((id) => resolveRole(this.state.strips[id], this.roleStore).role === 'walkin');
  }

  #walkin(action, seconds) {
    const ids = this.#walkinStrips();
    if (!ids.length) {
      this.alert({ level: 'warn', source: 'walkin', message: 'No walk-in music channel found. Name it "Walk-in" or set its role.' });
      return;
    }
    const secs = Math.min(60, Math.max(0.2, Number(seconds) || this.config.walkinFadeSeconds));
    const ms = secs * 1000;
    for (const id of ids) {
      const s = this.state.strips[id];
      if (action === 'out') {
        if (s.on && s.faderDb > -60) this.settings.walkinLevels[id] = s.faderDb;
        this.fades.fade(id, -Infinity, ms, { muteAtEnd: true });
      } else if (action === 'in') {
        const target = this.settings.walkinLevels[id] ?? -10;
        if (!s.on) {
          // Start from silence so unmuting doesn't blast at the old fader level.
          s.fader = 0;
          this.client.setFloat(paths.fader(id), 0);
        }
        this.fades.fade(id, target, ms, { unmuteFirst: true });
      } else return;
    }
    this.#saveSettings();
    this.alert({
      level: 'info',
      source: 'walkin',
      message: action === 'out' ? `Fading out walk-in music over ${secs} s.` : `Bringing up walk-in music over ${secs} s.`,
    });
  }

  #saveSettings() {
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  // ---------- web app ----------

  snapshot({ local = false } = {}) {
    const lockedIds = this.#lockedIds();
    const inv = buildInventory(this.state, this.roleStore, Date.now(), lockedIds);
    return {
      type: 'state',
      status: this.status,
      inventory: inv,
      clickGuard: this.guard ? this.guard.status() : { locked: [], allSafe: true, protectedBuses: [] },
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
      if (ws.isLocal) ws.send((local ??= this.#json(this.snapshot({ local: true }))));
      else ws.send((remote ??= this.#json(this.snapshot())));
    }
  }

  #checkPin(ip, pin) {
    const now = Date.now();
    const t = this.pinTries.get(ip) ?? { fails: 0, until: 0 };
    if (t.until > now) return { ok: false, retryIn: Math.ceil((t.until - now) / 1000) };
    if (String(pin ?? '') === this.pin) {
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

  #startHttp() {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
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
    });
    this.server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.config.httpPort} is already in use. Is Mix Assistant already running?`);
        process.exitCode = 1;
        this.stop();
      } else console.error('Web server error:', err.message);
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/ws', maxPayload: 16 * 1024 });
    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress;
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
        if (cmd?.type === 'auth') {
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
}
