// The booth bridge: talks to the XR18 over OSC/UDP and serves the web app.
//
//   npm start                      # find the XR18 on the network automatically
//   MIXER_HOST=192.168.1.50 npm start
//   npm run dev                    # bridge + simulated XR18

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { XAirClient, discoverMixers } from './xair/client.js';
import { paths, STRIP_IDS } from './xair/addresses.js';
import { dbToFloat, floatToDb } from './xair/faderLaw.js';
import { MixerState } from './mixerState.js';
import { RoleStore, buildInventory, resolveRole } from './inventory.js';
import { ClickGuard } from './clickGuard.js';
import { FadeEngine } from './fades.js';
import { LOCKED_ROLES, ROLES } from './roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const RESYNC_MS = 30000;
const PUSH_MS = 100;
const MAX_ALERTS = 50;

function loadConfig() {
  let file = {};
  try {
    // Installed copies keep config.json in the data folder so updates never overwrite it.
    const candidates = [process.env.DATA_DIR && path.join(process.env.DATA_DIR, 'config.json'), path.join(ROOT, 'config.json')];
    const found = candidates.find((f) => f && fs.existsSync(f));
    if (found) file = JSON.parse(fs.readFileSync(found, 'utf8'));
  } catch {
    /* defaults */
  }
  return {
    mixerHost: process.env.MIXER_HOST || file.mixerHost || 'auto',
    mixerPort: Number(process.env.MIXER_PORT || file.mixerPort || 10024),
    httpPort: Number(process.env.PORT || file.httpPort || 8080),
    walkinFadeSeconds: Number(file.walkinFadeSeconds || 8),
    dataDir: process.env.DATA_DIR || file.dataDir || path.join(ROOT, 'data'),
    keepAwake: file.keepAwake !== false,
  };
}

export class Bridge {
  constructor(config) {
    this.config = config;
    this.state = new MixerState();
    this.roleStore = new RoleStore(path.join(config.dataDir, 'roles.json'));
    this.settingsFile = path.join(config.dataDir, 'settings.json');
    this.settings = { walkinLevels: {} };
    try {
      this.settings = { ...this.settings, ...JSON.parse(fs.readFileSync(this.settingsFile, 'utf8')) };
    } catch {
      /* first run */
    }
    this.alerts = [];
    this.alertSeq = 0;
    this.status = { connected: false, mixer: null, host: null, searching: false };
    this.timers = [];
  }

  async start() {
    await this.#connectMixer();
    this.#startHttp();
    this.timers.push(setInterval(() => this.#push(), PUSH_MS));
    if (this.config.keepAwake && process.platform === 'darwin') {
      // Keep the Mac from sleeping while the bridge runs.
      this.caffeinate = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    }
    return this;
  }

  stop() {
    this.timers.forEach(clearInterval);
    this.fades?.stopAll();
    this.client?.stop();
    this.wss?.close();
    this.server?.close();
    this.caffeinate?.kill();
  }

  // ---------- mixer ----------

  async #connectMixer() {
    let host = this.config.mixerHost;
    if (host === 'auto') {
      this.status.searching = true;
      console.log('Looking for an XR18 on the network…');
      for (;;) {
        const found = await discoverMixers({ port: this.config.mixerPort });
        if (found.length) {
          host = found[0].host;
          console.log(`Found ${found[0].name} (${found[0].model}, firmware ${found[0].firmware}) at ${host}`);
          break;
        }
        console.log('No mixer found yet. Is this computer on the XR18 network? Retrying…');
        await new Promise((r) => setTimeout(r, 3000));
      }
      this.status.searching = false;
    }
    this.status.host = host;

    this.client = new XAirClient({ host, port: this.config.mixerPort });
    this.guard = new ClickGuard({
      state: this.state,
      client: this.client,
      roleStore: this.roleStore,
      onAlert: (a) => this.alert(a),
    });
    this.fades = new FadeEngine({ state: this.state, client: this.client });

    this.client.on('message', (msg) => this.state.apply(msg));
    this.client.on('connected', (info) => {
      this.status.connected = true;
      this.status.mixer = info;
      console.log(`Connected to mixer at ${host}`);
      this.alert({ level: 'ok', source: 'connection', message: 'Connected to the mixer.' });
      this.client.syncAll().then(() => setTimeout(() => this.guard.enforce(), 500));
    });
    this.client.on('disconnected', () => {
      this.status.connected = false;
      this.fades.stopAll();
      this.alert({ level: 'warn', source: 'connection', message: 'Lost contact with the mixer. Retrying…' });
    });
    this.client.on('error', (err) => console.error('Mixer link error:', err.message));

    // Enforce the click/guide lock the instant anything relevant changes.
    this.state.on('change', ({ id, field }) => {
      if (!id) return;
      if (field === 'lr' || field === 'send' || field === 'name') this.guard.enforce(id);
    });

    await this.client.start();
    // Backup: re-read everything periodically, then re-check the lock.
    this.timers.push(
      setInterval(() => {
        if (!this.status.connected) return;
        this.client.syncAll().then(() => setTimeout(() => this.guard.enforce(), 500));
      }, RESYNC_MS),
    );
  }

  alert({ level = 'info', source = 'app', message, id }) {
    const a = { alertId: ++this.alertSeq, at: Date.now(), level, source, message, strip: id ?? null };
    this.alerts.unshift(a);
    this.alerts.length = Math.min(this.alerts.length, MAX_ALERTS);
    console.log(`[${level}] ${message}`);
    return a;
  }

  // ---------- commands from the web app ----------

  handleCommand(cmd) {
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
        const { role } = resolveRole(s, this.roleStore);
        if (cmd.lr && LOCKED_ROLES.has(role)) {
          this.alert({ level: 'warn', source: 'click-guard', id: cmd.id, message: `${ROLES[role].label} can't go to the main speakers.` });
          return;
        }
        s.lr = !!cmd.lr;
        this.client.setInt(paths.lr(cmd.id), cmd.lr ? 1 : 0);
        return;
      }
      case 'setRole':
        if (!s) return;
        this.roleStore.set(cmd.id, s.name, cmd.role || null);
        this.guard.enforce(cmd.id);
        return;
      case 'walkin':
        return this.#walkin(cmd.action, cmd.seconds);
      case 'muteUnused': {
        const inv = buildInventory(this.state, this.roleStore);
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
    const ms = (Number(seconds) || this.config.walkinFadeSeconds) * 1000;
    for (const id of ids) {
      const s = this.state.strips[id];
      if (action === 'out') {
        if (s.on && s.faderDb > -60) this.settings.walkinLevels[id] = s.faderDb;
        this.fades.fade(id, -Infinity, ms, { muteAtEnd: true });
      } else {
        const target = this.settings.walkinLevels[id] ?? -10;
        if (!s.on) {
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
      message: action === 'out' ? `Fading out walk-in music over ${ms / 1000} s.` : `Bringing up walk-in music over ${ms / 1000} s.`,
    });
  }

  #saveSettings() {
    fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true });
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
  }

  // ---------- web app ----------

  snapshot() {
    const inv = buildInventory(this.state, this.roleStore);
    return {
      type: 'state',
      status: this.status,
      inventory: inv,
      clickGuard: this.guard.status(),
      dcas: Object.values(this.state.dcas),
      walkin: this.#walkinStrips().map((id) => ({ id, fading: this.fades.isFading(id), on: this.state.strips[id].on })),
      alerts: this.alerts.slice(0, 20),
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
    };
  }

  #push() {
    if (!this.wss || this.wss.clients.size === 0) return;
    const json = JSON.stringify(this.snapshot(), (k, v) => (v === -Infinity ? -999 : v));
    for (const ws of this.wss.clients) if (ws.readyState === 1) ws.send(json);
  }

  #startHttp() {
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/api/state') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(this.snapshot(), (k, v) => (v === -Infinity ? -999 : v)));
        return;
      }
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(PUBLIC, rel);
      if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    });
    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });
    this.wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        try {
          this.handleCommand(JSON.parse(data));
        } catch (err) {
          console.error('Bad command:', err.message);
        }
      });
    });
    this.server.listen(this.config.httpPort, '0.0.0.0', () => {
      console.log('\nOpen the app on any iPad, phone or computer on this network:');
      console.log(`  http://localhost:${this.config.httpPort}`);
      for (const addrs of Object.values(os.networkInterfaces())) {
        for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${this.config.httpPort}`);
      }
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
