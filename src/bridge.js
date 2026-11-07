// The booth bridge: talks to the XR18 over OSC/UDP and serves the web app.
//
//   npm start                      # find the XR18 on the network automatically
//   MIXER_HOST=192.168.1.50 npm start
//   npm run dev                    # practice mode: bridge + simulated XR18

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
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
import { MusicController, toSpotifyUri } from './music.js';
import { Updater } from './updater.js';
import { Library, INSTRUMENTS } from './library.js';
import { PlanningCenter } from './pco.js';
import { ProPresenter } from './propresenter.js';
import { Effects, VERB_LEVELS, DELAY_LEVELS, fxSendBus } from './effects.js';
import { TempoDetector, TEMPO_SOURCES } from './tempo.js';
import { FxDesk, REVERB_TWEAKS } from './fxsetup.js';
import { channelName } from './naming.js';
import { ToneDesk, applyPops, applyGain, applyFix, applyComp, applyGate, freshModel, toneToSave, describeTone, FIXES, COMP_PRESETS } from './tone.js';
import { CONNECTION_MODES, chooseMixer, hardwarePorts, kindLabel, pathTo } from './netpath.js';
import { ROLES, LOCKED_ROLES } from './roles.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
// QR codes for connecting iPads, served from the app itself (the Mac may have no internet).
const QR_SCRIPT = createRequire(import.meta.url).resolve('qrcode-generator');
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

const TONE_COMMANDS = new Set(['tonePops', 'toneGain', 'toneRead', 'toneFix', 'toneComp', 'toneGate', 'toneFresh', 'toneUndo', 'toneSave', 'toneLoad', 'toneVerb', 'toneDelay']);
const LIBRARY_COMMANDS = new Set([
  'saveSlot', 'deleteSlot', 'savePerson', 'deletePerson',
  'newSet', 'openSet', 'deleteSet', 'setLineup',
  'addSong', 'removeSong', 'moveSong', 'setSongLeads', 'playSong', 'nextSong', 'songMixAmounts',
  'pcoServiceTypes', 'pcoPlans', 'pcoImport', 'setSetChannel', 'placePerson', 'channelsDone', 'setSongDelay',
]);

// PA knob positions worth writing down, so a bumped knob can be put back next week.
const PA_FIELDS = [
  { id: 'prxGain', label: 'PRX ONE input gain (the XR18 inputs)' },
  { id: 'prxMaster', label: 'PRX ONE master volume' },
  { id: 'thruLevel', label: 'PRX ONE pass-thru level' },
  { id: 'thruHpf', label: 'PRX ONE pass-thru high-pass' },
  { id: 'passportChannel', label: 'Passport channel level' },
  { id: 'passportMaster', label: 'Passport master volume' },
  { id: 'xr18Main', label: 'XR18 main fader' },
  { id: 'roomLevel', label: 'Room level reached (dBA)' },
];

// Setup checklist items a person ticks (they reset each day). Built for a set-up/tear-down church.
const SETUP_ITEMS = [
  { id: 'speakers', label: 'Speakers powered, levels at their marks' },
  { id: 'bluetooth', label: 'PRX ONE Bluetooth off' },
  { id: 'wireless', label: 'Wireless mics scanned, fresh batteries in every pack' },
  { id: 'ears', label: 'In-ear packs on and everyone can hear' },
  { id: 'dnd', label: 'Laptop: Do Not Disturb on, lid stays open' },
  { id: 'playlist', label: 'Pre/post-service playlist downloaded (if there is no internet)' },
];

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
    // Both speakers get the same feed (XR18 main → PRX ONE → pass-thru → Passport), so warn about panning.
    monoPA: file.monoPA !== false,
    musicApp: file.musicApp === 'music' ? 'music' : 'spotify', // pre/post-service music player on the Mac
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

export function macLocalName() {
  const h = os.hostname().toLowerCase().replace(/\.$/, '');
  return h.endsWith('.local') ? h : `${h.split('.')[0]}.local`;
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
    this.library = new Library(path.join(config.dataDir, 'library.json'));
    this.pro = new ProPresenter({
      file: path.join(config.dataDir, 'propresenter.json'),
      ...(config.proFetch ? { fetchImpl: config.proFetch } : {}),
      onPresentation: (name) => this.#followPresentation(name),
    });
    this.proMatch = null; // { name, song } for the last presentation ProPresenter put up
    this.pco = new PlanningCenter({ file: path.join(config.dataDir, 'pco.json'), ...(config.pcoBaseUrl ? { baseUrl: config.pcoBaseUrl } : {}) });
    this.settingsFile = path.join(config.dataDir, 'settings.json');
    this.settings = { walkinLevels: {}, automix: {}, playlists: [], connection: 'auto', venues: [], venue: null, checklist: { date: '', done: {} } };
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
    this.updater = new Updater({
      appDir: ROOT,
      currentVersion: VERSION,
      source: this.config.updateSource,
      exit: this.config.updateExit ?? (() => {
        this.stop();
        process.exit(0);
      }),
      onAlert: (a) => this.alert(a),
    });
    this.music = new MusicController({
      appKey: this.config.musicApp,
      ...(this.config.musicRunner ? { runner: this.config.musicRunner, checkInternet: async () => true } : {}),
      onAlert: (a) => this.alert(a),
    }).start();
    this.#startHttp();
    this.pro.start();
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
    this.pro?.stop();
    this.fades?.stopAll();
    this.automix?.stop();
    this.effects?.stop();
    this.music?.stop();
    clearTimeout(this.pauseTimer);
    this.#stopPractice();
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
    // Work out which connection (Wi-Fi or cable) reaches each answer, then honour the preference.
    const portMap = await hardwarePorts();
    for (const m of found) m.path = pathTo(m.host, { portMap });
    const { pick, preferenceMet } = chooseMixer(found, this.settings.connection ?? 'auto', this.config.mixerName);
    this.preferenceMet = preferenceMet;
    if (pick && found.length > 1) console.log(`Found ${found.length} mixer addresses: ${found.map((m) => `${m.name} ${m.host} (${kindLabel(m.path?.kind)})`).join(', ')}`);
    return pick ?? null;
  }

  /** Which connection the Mac is using to reach the mixer right now. */
  async #updatePath() {
    const ip = this.client?.hostIp ?? this.status.host;
    const p = pathTo(ip, { portMap: await hardwarePorts() });
    this.status.path = p ? { kind: p.kind, label: kindLabel(p.kind), port: p.port, iface: p.iface, mixerIp: ip } : null;
  }

  /** Apply a new connection preference now, if the mixer can be reached that way. Never drops a working connection. */
  async #applyConnectionPreference() {
    if (this.config.mixerHost !== 'auto' || !this.client || this.rediscovering) return;
    this.rediscovering = true;
    try {
      const pick = await this.#discoverOnce();
      const mode = this.settings.connection ?? 'auto';
      if (pick && pick.host !== this.client.host) {
        console.log(`Switching to the mixer at ${pick.host} over ${kindLabel(pick.path?.kind)}`);
        await this.client.setHost(pick.host);
        this.status.host = pick.host;
        this.alert({ level: 'info', source: 'connection', message: `Now reaching the mixer over ${kindLabel(pick.path?.kind)}.` });
      } else if (mode !== 'auto' && !this.preferenceMet) {
        this.alert({
          level: 'warn',
          source: 'connection',
          message: `Can't find the mixer over ${mode === 'cable' ? 'a cable' : 'Wi-Fi'}${this.status.path ? `, so staying on ${this.status.path.label}` : ''}. Check the ${mode === 'cable' ? 'cable and adapter are plugged in' : "laptop is on the mixer's Wi-Fi"}.`,
        });
      }
      await this.#updatePath();
    } finally {
      this.rediscovering = false;
    }
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
    this.client.allowedAuxBuses = Array.isArray(this.config.protectedBuses) ? this.config.protectedBuses : [];
    this.client.on('blocked', (address) => {
      console.error(`Blocked a write to ${address}: the app never changes in-ear mixes, snapshots, phantom or mixer setup.`);
      if (Date.now() - (this.lastBlockedAlert ?? 0) > 60000) {
        this.lastBlockedAlert = Date.now();
        this.alert({ level: 'warn', source: 'safety', message: `Mix Assistant stopped itself changing ${address}. In-ear mixes, snapshots and phantom are never changed by the app. Please save a troubleshooting report.` });
      }
    });
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
    this.tone?.stop();
    this.tone = new ToneDesk({ client: this.client });
    this.automix = new AutoMix({
      state: this.state,
      client: this.client,
      roleStore: this.roleStore,
      isLocked: (id) => this.#lockedIds().includes(id),
      isFading: (id) => !!this.fades?.isFading(id),
      stateFile: path.join(this.config.dataDir, 'automix-state.json'),
      settings: { ...(this.config.automix ?? {}), ...(this.settings.automix ?? {}) },
      onAlert: (a) => this.alert(a),
    });
    this.automix.setFocus(this.library.focusForCurrentSong(), this.library.songContext());
    this.effects?.stop();
    this.effects = new Effects({
      state: this.state,
      client: this.client,
      roleStore: this.roleStore,
      settings: this.settings.effects ?? {},
      stateFile: path.join(this.config.dataDir, 'effects-state.json'),
      onAlert: (a) => this.alert(a),
    });
    this.fxdesk?.stop();
    this.fxdesk = new FxDesk({ client: this.client });
    this.effects.desk = this.fxdesk;
    this.effects.setSong(this.library.songEffects());
    this.automix.on('mode', ({ mode, auto }) => {
      const label = { walkin: 'Before / after', worship: 'Worship', talkover: 'Talking over music', speaking: 'Speaking' }[mode] ?? mode;
      this.alert({ level: 'info', source: 'automix', message: `${auto ? 'Switched' : 'Set'} to ${label}.` });
    });

    this.client.on('message', (msg) => this.state.apply(msg));
    this.state.on('meters', () => {
      if (this.automix.enabled) {
        try {
          this.automix.tick();
          this.#listenForTempo();
          this.effects?.tick({ mode: this.automix.mode, activity: this.automix.activity });
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
      this.#updatePath().then(() =>
        this.alert({ level: 'ok', source: 'connection', message: `Connected to the mixer${this.status.path && this.status.path.kind !== 'local' ? ` over ${this.status.path.label}` : ''}.` }),
      );
      this.#resync(() => {
        if (!this.automix.enabled) this.automix.start();
        if (!this.effects.started) this.effects.start();
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
    this.#updatePath().catch(() => {});
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
    const inv = buildInventory(this.state, this.roleStore, Date.now(), this.#lockedIds(), { monoPA: this.config.monoPA });
    return inv.rows.filter((r) => r.status === 'unused' && r.on && !r.locked);
  }

  // ---------- commands from the web app ----------

  handleCommand(cmd, { local = true } = {}) {
    if (!cmd || typeof cmd !== 'object' || typeof cmd.type !== 'string') return;
    // Things only the booth Mac's own screen can do (not iPads).
    if (['checkUpdate', 'installUpdate', 'practice', 'setConnection', 'saveVenue', 'deleteVenue', 'selectVenue'].includes(cmd.type)) {
      if (!local) return;
      if (cmd.type === 'checkUpdate') return this.updater.check();
      if (cmd.type === 'installUpdate') return this.updater.install();
      if (cmd.type === 'practice') return cmd.on ? this.#startPractice() : this.#stopPractice();
      return this.#venueCommand(cmd);
    }
    // The setup checklist can be ticked from any connected device.
    if (cmd.type === 'checkItem') return this.#checkItem(cmd);
    // PA knob positions can be noted from any device (a volunteer standing at the speaker).
    if (cmd.type === 'savePa') return this.#savePa(cmd);
    // People, channels, sets and songs: from any connected device. The token stays Mac-only.
    if (cmd.type === 'pcoSaveToken' || cmd.type === 'pcoForget') {
      if (!local) return;
      return this.#pcoTokenCommand(cmd);
    }
    if (LIBRARY_COMMANDS.has(cmd.type)) return this.#libraryCommand(cmd);
    if (cmd.type === 'proPresenter') return this.#proCommand(cmd);
    if (TONE_COMMANDS.has(cmd.type)) return this.#toneCommand(cmd);
    if (cmd.type === 'effects' && this.effects) {
      this.settings.effects = { ...this.effects.update(cmd.settings ?? {}) };
      this.#saveSettings();
      return;
    }
    if (cmd.type === 'options') {
      if (typeof cmd.nameChannels === 'boolean') this.settings.nameChannels = cmd.nameChannels;
      this.#saveSettings();
      return;
    }
    if (cmd.type?.startsWith('fx') && this.effects && this.fxdesk) return this.#fxCommand(cmd);
    if (cmd.type === 'effectsNudge' && this.effects) {
      const fx = cmd.which === 'delay' ? this.effects.settings.delayFx : this.effects.settings.reverbFx;
      const db = Math.max(-3, Math.min(3, Number(cmd.db) || 0));
      const now = fx && this.effects.nudgeReturn(fx, db);
      this.alert(now === false || now === undefined || now === null ? { level: 'warn', source: 'effects', message: `Couldn't read FX${fx}'s level from the mixer yet.` } : { level: 'ok', source: 'effects', message: `${cmd.which === 'delay' ? 'Delay' : 'Reverb'} in the room ${db > 0 ? 'up' : 'down'} to ${now.toFixed(1)} dB.` });
      return;
    }
    // Never act on a mixer we can't reach: the screen would show changes that didn't happen.
    // Commands that don't need the mixer.
    const offlineOk = new Set(['dismissAlert', 'clearAlerts', 'music', 'addPlaylist', 'removePlaylist']);
    if (cmd.type === 'music' || cmd.type === 'addPlaylist' || cmd.type === 'removePlaylist') return this.#musicCommand(cmd);
    if (!this.client) return; // still searching for the mixer
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
      case 'walkinStart':
        return this.#walkinStart(cmd.playlist);
      case 'walkinEnd':
        return this.#walkinEnd();
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
          ride: updated.ride,
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

  // ---------- connection preference, venues and the setup checklist ----------

  #venueCommand(cmd) {
    const clean = (v, n) => String(v ?? '').trim().slice(0, n);
    const venues = this.settings.venues ?? (this.settings.venues = []);
    if (cmd.type === 'setConnection') {
      if (!CONNECTION_MODES[cmd.mode]) return;
      this.settings.connection = cmd.mode;
      // Keep the chosen venue's saved connection in step.
      if (Number.isInteger(this.settings.venue) && venues[this.settings.venue]) venues[this.settings.venue].connection = cmd.mode;
      this.#saveSettings();
      return this.#applyConnectionPreference();
    }
    if (cmd.type === 'saveVenue') {
      const name = clean(cmd.name, 40);
      if (!name) return;
      const v = { name, connection: CONNECTION_MODES[cmd.connection] ? cmd.connection : this.settings.connection ?? 'auto', notes: clean(cmd.notes, 1000) };
      const i = Number.isInteger(cmd.index) && venues[cmd.index] ? cmd.index : venues.length;
      if (i === venues.length && venues.length >= 20) return;
      venues[i] = v;
      this.settings.venue = i;
      this.settings.connection = v.connection;
      this.#saveSettings();
      this.alert({ level: 'ok', source: 'venue', message: `Saved venue "${name}".` });
      return this.#applyConnectionPreference();
    }
    if (cmd.type === 'deleteVenue') {
      if (!Number.isInteger(cmd.index) || !venues[cmd.index]) return;
      venues.splice(cmd.index, 1);
      if (this.settings.venue === cmd.index) this.settings.venue = null;
      else if (this.settings.venue > cmd.index) this.settings.venue--;
      this.#saveSettings();
      return;
    }
    if (cmd.type === 'selectVenue') {
      if (cmd.index === null) {
        this.settings.venue = null;
        this.#saveSettings();
        return;
      }
      const v = Number.isInteger(cmd.index) ? venues[cmd.index] : null;
      if (!v) return;
      this.settings.venue = cmd.index;
      this.settings.connection = v.connection;
      this.#saveSettings();
      return this.#applyConnectionPreference();
    }
  }

  #today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** Ticks reset each day, so every Sunday starts with a fresh checklist. */
  #checklistDone() {
    const c = this.settings.checklist ?? (this.settings.checklist = { date: '', done: {} });
    if (c.date !== this.#today()) {
      c.date = this.#today();
      c.done = {};
    }
    return c.done;
  }

  // ---------- people, channels, sets, songs and Planning Center ----------

  // ---------- tone at soundcheck: EQ, compression, gate per person ----------

  /** Channels, person and instrument on a position this week, with the channel's current tone read. */
  async #toneTarget(slotId) {
    const t = this.library.slotThisWeek(String(slotId));
    if (!t || !this.tone || !t.channels.length) return null;
    const name = this.library.person(t.personId)?.name ?? 'them';
    const model = this.tone.model(t.channels[0]) ?? (await this.tone.read(t.channels[0]));
    for (const ch of t.channels.slice(1)) if (!this.tone.model(ch)) await this.tone.read(ch);
    return { ...t, name, model };
  }

  async #toneCommand(cmd) {
    if (!this.status.connected) {
      this.alert({ level: 'warn', source: 'tone', message: "The mixer isn't connected, so that change wasn't made." });
      return;
    }
    const t = await this.#toneTarget(cmd.slotId);
    if (!t) return;
    if (!t.model) {
      this.alert({ level: 'warn', source: 'tone', message: `Couldn't read channel ${t.channels[0]}'s EQ from the mixer. Try again.` });
      return;
    }
    let r = null;
    switch (cmd.type) {
      case 'toneRead':
        return;
      case 'toneFix':
        if (!FIXES[t.instrument]?.[cmd.fix] && !FIXES.vocal[cmd.fix]) return;
        r = applyFix(t.model, t.instrument, String(cmd.fix));
        break;
      case 'tonePops':
        r = cmd.off ? applyPops(t.model, 'off') : applyPops(t.model, Math.max(-60, Math.min(0, Number(cmd.loudDb))), [-3, 3].includes(Number(cmd.nudge)) ? Number(cmd.nudge) : 0);
        break;
      case 'toneGain':
        r = applyGain(t.model, Math.max(-60, Math.min(0, Number(cmd.loudDb))));
        break;
      case 'toneComp':
        if (cmd.preset !== 'off' && !COMP_PRESETS[cmd.preset]) return;
        r = applyComp(t.model, cmd.preset, Math.max(-60, Math.min(0, Number(cmd.loudDb))));
        break;
      case 'toneGate':
        r = applyGate(t.model, !!cmd.on, Math.max(-90, Math.min(-20, Number(cmd.floorDb))));
        break;
      case 'toneFresh':
        r = { model: freshModel(t.instrument), note: 'Started fresh: EQ flat, low cut set, no compression or gate' };
        break;
      case 'toneUndo':
        this.tone.undo(t.channels.map(String));
        return;
      case 'toneVerb': {
        const fx = this.effects?.settings.reverbFx;
        if (!fx || !(cmd.level in VERB_LEVELS)) return;
        const db = VERB_LEVELS[cmd.level];
        for (const ch of t.channels) this.#setFxSend(ch, fx, db);
        this.tone.notes.set(String(t.channels[0]), `Reverb: ${cmd.level === 'dry' ? 'dry (none)' : `${cmd.level} (send ${db} dB)`}`);
        return;
      }
      case 'toneDelay': {
        if (!(cmd.level in DELAY_LEVELS)) return;
        const saved = { ...(this.library.personTone(t.personId, t.instrument) ?? {}) };
        saved.delayDb = DELAY_LEVELS[cmd.level];
        if (cmd.level === 'off') saved.delayOff = true;
        else delete saved.delayOff;
        this.library.savePersonTone(t.personId, t.instrument, saved);
        this.effects?.setSong(this.library.songEffects());
        this.tone.notes.set(String(t.channels[0]), `Delay on their songs: ${cmd.level}`);
        return;
      }
      case 'toneSave': {
        const keep = this.library.personTone(t.personId, t.instrument) ?? {};
        const fx = this.effects?.settings.reverbFx;
        const verb = fx ? this.state.strips[t.channels[0]]?.sends?.[fxSendBus(fx)] : undefined;
        this.library.savePersonTone(t.personId, t.instrument, { ...toneToSave(t.model), verbDb: verb > 0 ? Math.round(floatToDb(verb) * 10) / 10 : verb === 0 ? null : keep.verbDb, delayDb: keep.delayDb, delayOff: keep.delayOff });
        this.alert({ level: 'ok', source: 'tone', message: `Saved ${t.name}'s ${t.instrument === 'vocal' ? 'vocal' : t.slot.name.toLowerCase()} tone. It loads onto their channel each week when you tap "Channels are set".` });
        return;
      }
      case 'toneLoad': {
        const saved = this.library.personTone(t.personId, t.instrument);
        if (!saved) return;
        const fxv = this.effects?.settings.reverbFx;
        if (fxv && saved.verbDb !== undefined) for (const ch of t.channels) this.#setFxSend(ch, fxv, saved.verbDb);
        r = { model: { ...t.model, ...saved, b1: { ...t.model.b1, ...saved.b1 }, b2: { ...t.model.b2, ...saved.b2 }, b3: { ...t.model.b3, ...saved.b3 }, b4: { ...t.model.b4, ...saved.b4 }, comp: { ...t.model.comp, ...saved.comp }, gate: { ...t.model.gate, ...saved.gate } }, note: `Loaded ${t.name}'s saved tone` };
        break;
      }
      default:
        return;
    }
    if (!r?.note) return;
    if (r.model === t.model) {
      this.tone.notes.set(String(t.channels[0]), r.note);
      return;
    }
    this.tone.write(t.channels.map(String), r.model, r.note);
  }

  /** A channel's send to an effect (dB, or null for none). Never an in-ear (aux) send. */
  #setFxSend(ch, fx, db) {
    const bus = fxSendBus(fx);
    const v = db === null ? 0 : dbToFloat(db);
    const s = this.state.strips[String(ch)];
    if (s) s.sends[bus] = v;
    this.client.setFloat(paths.send(String(ch), bus), v);
  }

  /** Channels confirmed for the week: put each person's saved tone on their channel. */
  async #loadSavedTones() {
    const set = this.library.set();
    if (!set || !this.tone || !this.status.connected) return;
    const loaded = [];
    for (const slotId of Object.keys(set.lineup)) {
      const t = this.library.slotThisWeek(slotId);
      if (!t || !this.library.personTone(t.personId, t.instrument)) continue;
      await this.#toneCommand({ type: 'toneLoad', slotId });
      const name = this.library.person(t.personId)?.name?.split(' ')[0];
      loaded.push(`${name}${t.instrument === 'vocal' ? '' : `'s ${t.slot.name.toLowerCase()}`} (ch ${t.channels.join('/')})`);
    }
    if (loaded.length) this.alert({ level: 'ok', source: 'tone', message: `Loaded saved EQ and compression: ${loaded.join(', ')}. Undo in each person's Tone if this week sounds different.` });
  }

  /** Name this week's channels on the mixer after the people on them. Never click, guide or a clash. */
  #nameChannels() {
    const set = this.library.set();
    if (!set || !this.status.connected) return;
    const done = new Set();
    const named = [];
    const skipped = [];
    for (const slotId of Object.keys(set.lineup)) {
      const t = this.library.slotThisWeek(slotId);
      if (!t) continue;
      const person = this.library.person(t.personId)?.name ?? '';
      t.channels.forEach((ch, i) => {
        const s = this.state.strips[String(ch)];
        if (!s || ch === 'aux') return;
        const { role } = resolveRole(s, this.roleStore);
        if (LOCKED_ROLES.has(role) || this.guard?.status().locked.some((l) => l.id === String(ch))) {
          skipped.push(`ch ${ch} is the ${role === 'guide' ? 'guide' : 'click'}, so ${person.split(' ')[0]} can't be on it: check their channel`);
          return;
        }
        if (done.has(String(ch))) {
          skipped.push(`ch ${ch} is set for two people this week`);
          return;
        }
        done.add(String(ch));
        const side = t.channels.length > 1 ? (i === 0 ? 'L' : 'R') : null;
        const name = channelName(person, t.instrument, side);
        if (s.name === name) return;
        s.name = name;
        this.client.send(paths.name(String(ch)), [{ type: 's', value: name }]);
        named.push(`${ch} "${name}"`);
      });
    }
    if (named.length) this.alert({ level: 'ok', source: 'set', message: `Named this week's channels on the mixer: ${named.join(', ')}.` });
    if (skipped.length) this.alert({ level: 'warn', source: 'set', message: `Not named: ${skipped.join('; ')}.` });
  }

  /** What the Set tab shows for each position's tone. */
  #toneSnapshot() {
    const out = {};
    const set = this.library.set();
    if (!set || !this.tone) return out;
    for (const slotId of Object.keys(set.lineup)) {
      const t = this.library.slotThisWeek(slotId);
      if (!t?.channels.length) continue;
      const st = this.tone.status(t.channels[0]);
      const saved = this.library.personTone(t.personId, t.instrument);
      const fx = this.effects?.settings.reverbFx;
      const send = fx ? this.state.strips[t.channels[0]]?.sends?.[fxSendBus(fx)] : undefined;
      const verbDb = send > 0 ? floatToDb(send) : send === 0 ? null : undefined;
      const verb = verbDb === undefined ? null : verbDb === null ? 'dry' : verbDb < -15 ? 'little' : verbDb < -9.5 ? 'normal' : 'more';
      const delay = saved?.delayOff ? 'off' : saved?.delayDb === DELAY_LEVELS.more ? 'more' : 'light';
      out[slotId] = { channels: t.channels, ...(st ?? {}), verb, delay, saved: saved?.savedAt ? { at: saved.savedAt, summary: describeTone(saved) } : null };
    }
    return out;
  }

  // ---------- one-tap effect setup, then the app runs the reverb and delay ----------

  async #fxCommand(cmd) {
    if (!this.status.connected) {
      this.alert({ level: 'warn', source: 'effects', message: "The mixer isn't connected, so that change wasn't made." });
      return;
    }
    const E = this.effects;
    const kind = cmd.kind === 'delay' ? 'delay' : 'reverb';
    const fx = kind === 'reverb' ? E.settings.reverbFx : E.settings.delayFx;
    const save = () => {
      this.settings.effects = { ...E.settings };
      this.#saveSettings();
    };
    switch (cmd.type) {
      case 'fxSetup':
      case 'fxAnswer': {
        if (!fx) return;
        if (cmd.type === 'fxAnswer' && cmd.ok) {
          const conf = this.fxdesk.confirm(kind);
          this.fxAsk = null;
          if (!conf) return;
          E.settings.fxConf = { ...E.settings.fxConf, [kind]: conf };
          E.lastDelayMs = null;
          save();
          this.alert({ level: 'ok', source: 'effects', message: kind === 'reverb' ? `Mix Assistant now runs the reverb on FX${fx}. Use the reverb buttons to change how it sounds.` : `Mix Assistant now runs the delay on FX${fx}, including its time from each song's tempo.` });
          return;
        }
        if (cmd.type === 'fxSetup') await this.fxdesk.cancel(kind); // start over
        const ms = kind === 'delay' ? (E.status().delayMs ?? 500) : null;
        const shown = await this.fxdesk.trySetup(kind, fx, kind === 'delay' ? { time: cmd.type === 'fxSetup' ? 500 : ms ?? 500 } : {});
        if (!shown) {
          this.fxAsk = null;
          this.alert({ level: 'warn', source: 'effects', message: `FX${fx} couldn't be set up automatically on this mixer, so it's back exactly as it was. Set it in X Air using the starting settings shown, and please mention it in the troubleshooting report.` });
          return;
        }
        this.fxAsk = { kind, fx, ...shown };
        return;
      }
      case 'fxCancel':
        await this.fxdesk.cancel(kind);
        this.fxAsk = null;
        this.alert({ level: 'info', source: 'effects', message: `FX${fx} is back as it was.` });
        return;
      case 'fxTweak': {
        const conf = E.conf('reverb');
        if (!conf || !REVERB_TWEAKS[cmd.id]) return;
        this.fxNote = this.fxdesk.tweak(conf, cmd.id);
        return;
      }
      case 'fxUndo': {
        const conf = E.conf('reverb');
        if (conf && this.fxdesk.undoTweak(conf)) this.fxNote = 'Undone';
        return;
      }
      case 'fxForget':
        E.update({ forget: kind });
        save();
        this.alert({ level: 'info', source: 'effects', message: `Mix Assistant no longer changes FX${fx}'s settings. It stays as it is now.` });
        return;
      default:
    }
  }

  /** Live tempo from the click, the tracks or the band; learned into the song once it's steady. */
  #listenForTempo() {
    this.tempo ??= new TempoDetector();
    const lib = this.library;
    const songKey = `${lib.data.currentSet}:${lib.data.currentSong}`;
    if (songKey !== this.tempoSong) {
      this.tempoSong = songKey;
      this.tempo.reset();
      this.tempoSteady = null;
    }
    const now = Date.now();
    if (!this.tempoRoles || now - this.tempoRolesAt > 2000) {
      this.tempoRolesAt = now;
      this.tempoRoles = { click: [], track: [], band: [] };
      for (const id of STRIP_IDS) {
        const s = this.state.strips[id];
        if (!s?.synced) continue;
        const { role } = resolveRole(s, this.roleStore);
        if (role === 'click') this.tempoRoles.click.push(id);
        else if (role === 'track') this.tempoRoles.track.push(id);
        else if (ROLES[role]?.group === 'band') this.tempoRoles.band.push(id);
      }
    }
    const lvl = (ids) => ids.map((id) => this.state.strips[id].levelDb ?? -128);
    const song = lib.set()?.songs[lib.data.currentSong];
    const r = this.tempo.feed({ click: lvl(this.tempoRoles.click), track: lvl(this.tempoRoles.track), band: lvl(this.tempoRoles.band) }, now, song?.bpm ?? null);
    this.effects?.setLive(r ? { ...r, label: TEMPO_SOURCES[r.source] } : null);
    // Steady for 8 seconds during a song: remember it as the song's tempo.
    if (!r || !song || this.automix?.mode !== 'worship') {
      this.tempoSteady = null;
      return;
    }
    if (!this.tempoSteady || Math.abs(this.tempoSteady.bpm - r.bpm) > 1.5) this.tempoSteady = { bpm: r.bpm, since: now };
    else if (now - this.tempoSteady.since >= 8000 && (!song.bpm || Math.abs(song.bpm - r.bpm) > 1.5)) {
      lib.setSongDelay(lib.data.currentSong, { bpm: r.bpm });
      this.effects?.setSong(lib.songEffects());
    }
  }

  /** ProPresenter put up a presentation: if it's a song in today's set, go to that song. */
  #followPresentation(name) {
    const lib = this.library;
    const i = lib.matchSong(name);
    this.proMatch = { name, song: i >= 0 ? lib.set().songs[i].title : null };
    if (i < 0 || i === lib.data.currentSong) return;
    lib.playSong(i);
    this.automix?.hintMode('worship');
    this.automix?.setFocus(lib.focusForCurrentSong(), lib.songContext());
    this.effects?.setSong(lib.songEffects());
  }

  #proCommand(cmd) {
    try {
      this.pro.configure({ host: cmd.host, port: cmd.port, follow: cmd.follow });
      this.proMatch = null;
      if (cmd.host !== undefined) this.alert({ level: 'ok', source: 'pro', message: this.pro.settings.host ? `ProPresenter address saved (${this.pro.settings.host}:${this.pro.settings.port}).` : 'ProPresenter link removed.' });
    } catch (e) {
      this.alert({ level: 'warn', source: 'pro', message: e.message });
    }
  }

  #pcoTokenCommand(cmd) {
    if (cmd.type === 'pcoForget') {
      this.pco.forget();
      this.alert({ level: 'info', source: 'pco', message: 'Planning Center token removed from this Mac.' });
      return;
    }
    try {
      this.pco.saveToken(cmd.appId, cmd.secret);
      this.alert({ level: 'ok', source: 'pco', message: 'Planning Center token saved on this Mac. Loading your service types…' });
      return this.pco.serviceTypes().catch((err) => this.alert({ level: 'warn', source: 'pco', message: err.message }));
    } catch (err) {
      this.alert({ level: 'warn', source: 'pco', message: err.message });
    }
  }

  async #libraryCommand(cmd) {
    const lib = this.library;
    const int = (v) => (Number.isInteger(v) ? v : null);
    try {
      switch (cmd.type) {
        case 'saveSlot':
          lib.saveSlot(cmd.slot);
          break;
        case 'deleteSlot':
          lib.deleteSlot(String(cmd.id));
          break;
        case 'savePerson':
          lib.savePerson(cmd.person);
          break;
        case 'deletePerson':
          lib.deletePerson(String(cmd.id));
          break;
        case 'newSet':
          lib.newSet({ title: cmd.title, date: cmd.date });
          break;
        case 'openSet':
          lib.openSet(String(cmd.id));
          break;
        case 'deleteSet':
          lib.deleteSet(String(cmd.id));
          break;
        case 'placePerson': {
          const label = INSTRUMENTS[cmd.instrument]?.label ?? 'that';
          const ok = lib.placePerson(String(cmd.personId), String(cmd.instrument), !!cmd.on);
          if (!ok && cmd.on) this.alert({ level: 'warn', source: 'set', message: `No free ${cmd.instrument === 'vocal' ? 'vocal mic' : label.toLowerCase()} position. Free one up, or add a position under Channels for each position.` });
          break;
        }
        case 'setSongDelay':
          lib.setSongDelay(int(cmd.index), { delay: cmd.delay, bpm: cmd.bpm });
          break;
        case 'channelsDone':
          lib.setChannelsDone(!!cmd.done);
          if (cmd.done) {
            await this.#loadSavedTones();
            if (this.settings.nameChannels !== false) this.#nameChannels();
          }
          break;
        case 'setSetChannel':
          lib.setSetChannel(String(cmd.slotId), cmd.left === null ? '' : String(cmd.left ?? ''), String(cmd.right ?? ''));
          break;
        case 'setLineup':
          lib.setLineup(String(cmd.slotId), cmd.personId ? String(cmd.personId) : null);
          break;
        case 'addSong':
          lib.addSong({ title: cmd.title, key: cmd.key });
          break;
        case 'removeSong':
          lib.removeSong(int(cmd.index));
          break;
        case 'moveSong':
          lib.moveSong(int(cmd.index), Number(cmd.dir));
          break;
        case 'setSongLeads':
          lib.setSongLeads(int(cmd.index), { lead: cmd.lead, harmonies: cmd.harmonies, leadInstrument: cmd.leadInstrument });
          break;
        case 'playSong':
          lib.playSong(int(cmd.index));
          if (lib.data.currentSong !== null) this.automix?.hintMode('worship');
          break;
        case 'nextSong':
          lib.nextSong();
          if (lib.data.currentSong !== null) this.automix?.hintMode('worship');
          break;
        case 'songMixAmounts':
          lib.setMix(cmd.mix ?? {});
          break;
        case 'pcoServiceTypes':
          await this.pco.serviceTypes();
          break;
        case 'pcoPlans':
          await this.pco.upcomingPlans(String(cmd.serviceTypeId));
          break;
        case 'pcoImport': {
          const plan = await this.pco.plan(String(cmd.serviceTypeId), String(cmd.planId));
          const { set, unplaced } = lib.importPlan(plan);
          this.alert({
            level: unplaced.length ? 'warn' : 'ok',
            source: 'pco',
            message: `Imported "${set.title}": ${set.songs.length} songs, ${Object.keys(set.lineup).length} people placed.${unplaced.length ? ` No free position for: ${unplaced.join(', ')}. Add a channel for them or place them by hand.` : ''}`,
          });
          break;
        }
        default:
          return;
      }
    } catch (err) {
      if (cmd.type.startsWith('pco')) this.alert({ level: 'warn', source: 'pco', message: err.message });
      else console.error('Library command failed:', err.message);
    }
    // Whatever changed, the song mix follows the current song.
    this.automix?.setFocus(lib.focusForCurrentSong(), lib.songContext());
    this.effects?.setSong(lib.songEffects());
  }

  /** What the Set tab needs. */
  #setSnapshot() {
    const d = this.library.snapshot();
    const set = this.library.set();
    const nameOf = (id) => this.library.person(id)?.name ?? null;
    return {
      slots: d.slots,
      people: d.people.map(({ id, name, instruments }) => ({ id, name, instruments })),
      instruments: d.instruments,
      toneFixes: Object.fromEntries(Object.entries(FIXES).map(([k, v]) => [k, Object.entries(v).map(([id, f]) => ({ id, label: f.label, hint: f.hint }))])),
      mix: d.mix,
      sets: d.sets.map((s) => ({ id: s.id, title: s.title, date: s.date, fromPco: !!s.pco, songs: s.songs.length })),
      current: set
        ? {
            ...set,
            songs: set.songs.map((s) => ({ ...s, leadName: nameOf(s.lead), harmonyNames: s.harmonies.map(nameOf).filter(Boolean), leadInstrumentName: this.library.slot(s.leadInstrument)?.name ?? null })),
          }
        : null,
      currentSong: d.currentSong,
      pco: this.pco.status(),
      pro: { ...this.pro.status(), match: this.proMatch },
      tone: this.#toneSnapshot(),
    };
  }

  /** Where PA settings live: on the chosen venue, or the default set when no venue is chosen. */
  #paTarget() {
    const v = Number.isInteger(this.settings.venue) ? this.settings.venues?.[this.settings.venue] : null;
    if (v) return { holder: v, venueName: v.name };
    return { holder: this.settings, venueName: null };
  }

  #savePa(cmd) {
    if (!cmd.fields || typeof cmd.fields !== 'object') return;
    const { holder, venueName } = this.#paTarget();
    const pa = { ...(holder.pa ?? {}) };
    for (const f of PA_FIELDS) {
      if (typeof cmd.fields[f.id] === 'string') pa[f.id] = cmd.fields[f.id].trim().slice(0, 40);
    }
    pa.savedAt = new Date().toISOString();
    holder.pa = pa;
    this.#saveSettings();
    this.alert({ level: 'ok', source: 'pa', message: `Saved the PA settings${venueName ? ` for ${venueName}` : ''}.` });
  }

  #paSnapshot() {
    const { holder, venueName } = this.#paTarget();
    return { fields: PA_FIELDS, values: holder.pa ?? {}, venueName };
  }

  #checkItem(cmd) {
    if (!SETUP_ITEMS.some((i) => i.id === cmd.id) || typeof cmd.done !== 'boolean') return;
    const done = this.#checklistDone();
    if (cmd.done) done[cmd.id] = true;
    else delete done[cmd.id];
    this.#saveSettings();
  }

  #ipadCount() {
    let n = 0;
    for (const ws of this.wss?.clients ?? []) if (ws.readyState === 1 && ws.authed && !ws.isLocal) n++;
    return n;
  }

  /** The setup checklist: things the app can check itself, then things a person ticks. */
  #checklist() {
    const st = this.status;
    const g = this.guard ? this.guard.status() : null;
    const m = this.music?.status();
    const pathText = st.path && st.path.kind !== 'local' ? ` over ${st.path.label}` : '';
    const auto = [
      { id: 'auto-mixer', label: 'Mixer connected', ok: !!st.connected, detail: st.connected ? `${st.mixer?.name ?? 'XR18'}${pathText}` : st.searching ? 'Looking for it…' : 'Not connected' },
      { id: 'auto-lock', label: 'Click and guide locked out of the room', ok: !!g && g.locked.length > 0 && g.allSafe, detail: !g ? 'Waiting for the mixer' : !g.locked.length ? 'No Click or Guide channel found' : g.allSafe ? 'Locked' : 'Being fixed' },
      { id: 'auto-ipads', label: 'iPad connected', ok: this.#ipadCount() > 0, detail: `${this.#ipadCount()} connected` },
    ];
    if (m?.available) {
      auto.push({
        id: 'auto-music',
        label: 'Music player ready',
        ok: !m.error,
        detail: m.error ? m.error : `${m.label}${m.internet === false ? ' · no internet: downloaded playlists only' : ''}`,
      });
    }
    const done = this.#checklistDone();
    const manual = SETUP_ITEMS.map((i) => ({ ...i, done: !!done[i.id] }));
    const v = Number.isInteger(this.settings.venue) ? this.settings.venues?.[this.settings.venue] : null;
    return { auto, manual, venue: v ? { name: v.name, notes: v.notes } : null, date: this.#today() };
  }

  // ---------- practice mode (a pretend mixer, started from the app) ----------

  #startPractice() {
    if (this.practice) return;
    const port = String(this.config.practicePort ?? 8081);
    this.practice = spawn(process.execPath, [path.join(ROOT, 'src', 'dev.js')], {
      cwd: ROOT,
      env: { ...process.env, PORT: port, SIM_PORT: String(this.config.practiceSimPort ?? 10124), DATA_DIR: '' },
      stdio: 'ignore',
    });
    this.practice.on('exit', () => {
      this.practice = null;
    });
    this.practice.on('error', () => {
      this.practice = null;
    });
    this.alert({ level: 'info', source: 'practice', message: `Practice mode started. It opens at http://localhost:${port}` });
  }

  #stopPractice() {
    if (!this.practice) return;
    this.practice.kill();
    this.practice = null;
  }

  /** Plain-text report for troubleshooting: what the app sees, recent alerts and the end of the log. */
  report() {
    const snap = this.snapshot({ local: false });
    const lines = [];
    lines.push(`Mix Assistant ${VERSION} report, ${new Date().toString()}`);
    lines.push(`Mac: ${os.hostname()} · macOS/Node ${process.platform} ${process.version}`);
    lines.push(`Mixer: ${snap.status.connected ? 'connected' : 'NOT connected'} ${snap.status.mixer ? JSON.stringify(snap.status.mixer) : ''} host ${snap.status.host ?? '-'}`);
    lines.push(`Addresses: ${lanAddresses().join(', ') || 'none'}`);
    lines.push('', 'Channels (id · name · role · status · on · fader dB · pan · LR · level dB):');
    for (const r of snap.inventory.rows) {
      lines.push(`  ${r.label} · ${r.name || '-'} · ${r.role} · ${r.status} · ${r.on ? 'on' : 'MUTED'} · ${r.faderDb === -Infinity ? '-inf' : r.faderDb.toFixed(1)} · ${r.pan?.toFixed(2)} · ${r.lr ? 'LR' : '-'} · ${Number(r.levelDb).toFixed(1)}`);
    }
    if (snap.automix) {
      lines.push('', `Auto-mix: mode ${snap.automix.mode}${snap.automix.modeLocked ? ' (set by a person)' : ''} · ${JSON.stringify(snap.automix.settings)}`);
      for (const c of snap.automix.channels) lines.push(`  ${c.name || c.id}: ${c.offsetDb} dB${c.mutedByAuto ? ' · down for sermon' : ''}`);
    }
    lines.push('', `Click lock: ${JSON.stringify(snap.clickGuard.locked)}`);
    lines.push(`Music: ${JSON.stringify(snap.music)}`);
    lines.push('', 'Recent alerts:');
    for (const a of this.alerts.slice(0, 30)) lines.push(`  ${new Date(a.at).toLocaleTimeString()} [${a.level}] ${a.message}`);
    const logFile = this.config.logFile ?? path.join(path.dirname(this.config.dataDir), 'logs', 'bridge.log');
    try {
      const text = fs.readFileSync(logFile, 'utf8').split('\n');
      lines.push('', `Last ${Math.min(300, text.length)} lines of ${logFile}:`, ...text.slice(-300));
    } catch {
      lines.push('', '(No log file found.)');
    }
    return lines.join('\n');
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
      this.alert({ level: 'warn', source: 'walkin', message: 'No pre/post-service music channel found. Name it "Spotify" or "Pre/Post" in the X Air app, or set its role.' });
      return;
    }
    const secs = Math.min(60, Math.max(0.2, isFiniteNum(seconds) ? seconds : this.config.walkinFadeSeconds));
    const ms = secs * 1000;
    for (const id of ids) {
      const s = this.state.strips[id];
      if (action === 'out') {
        // Remember the level a person set, not a level the auto-mix had ducked it to.
        const level = this.automix?.homeDb(id) ?? s.faderDb;
        if (s.on && level > -60) this.settings.walkinLevels[id] = level;
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
      message: action === 'out' ? `Fading the music out over ${secs} s.` : `Fading the music in over ${secs} s.`,
    });
  }

  // ---------- pre/post-service music player ----------

  async #musicCommand(cmd) {
    if (cmd.type === 'addPlaylist') {
      const name = String(cmd.name ?? '').trim().slice(0, 60);
      let link = String(cmd.link ?? '').trim();
      if (this.config.musicApp === 'spotify') {
        const uri = toSpotifyUri(link);
        if (!uri) {
          this.alert({ level: 'warn', source: 'music', message: "That doesn't look like a Spotify playlist link. In Spotify, use Share → Copy link to playlist." });
          return;
        }
        link = uri;
      } else if (!link) link = name; // Apple Music plays playlists by name
      if (!name && !link) return;
      this.settings.playlists = [...(this.settings.playlists ?? []), { name: name || 'Pre-service playlist', link }].slice(-10);
      this.#saveSettings();
      this.alert({ level: 'ok', source: 'music', message: `Saved "${name || 'Pre-service playlist'}".` });
      return;
    }
    if (cmd.type === 'removePlaylist') {
      const i = Number(cmd.index);
      if (!Number.isInteger(i) || !this.settings.playlists?.[i]) return;
      this.settings.playlists.splice(i, 1);
      this.#saveSettings();
      return;
    }
    const action = cmd.action;
    if (!['play', 'pause', 'next', 'previous'].includes(action)) return;
    if (action === 'play' || action === 'pause') clearTimeout(this.pauseTimer);
    await this.music.command(action);
  }

  /** One tap before or after the service: start the playlist (or resume) and fade the music channel in. */
  async #walkinStart(index) {
    clearTimeout(this.pauseTimer);
    const pl = Number.isInteger(index) ? this.settings.playlists?.[index] : null;
    const ok = pl ? await this.music.command('playList', pl.link) : await this.music.command('play');
    this.#walkin('in');
    if (!ok) this.alert({ level: 'warn', source: 'music', message: 'The music channel is up, but the player didn\'t start. Check Spotify on the Mac.' });
  }

  /** One tap when the service starts (or the room has emptied): fade the music channel out, then pause the player. */
  #walkinEnd() {
    clearTimeout(this.pauseTimer);
    this.#walkin('out');
    this.pauseTimer = setTimeout(() => {
      // Only pause if nobody brought walk-in back up meanwhile.
      const stillOff = this.#walkinStrips().every((id) => !this.state.strips[id].on);
      if (stillOff) this.music.command('pause');
    }, this.config.walkinFadeSeconds * 1000 + 500);
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
    const inv = buildInventory(this.state, this.roleStore, Date.now(), lockedIds, { monoPA: this.config.monoPA !== false });
    return {
      type: 'state',
      status: this.status,
      inventory: inv,
      unusedReady: this.state.settled(UNUSED_SETTLE_MS),
      unused: this.state.settled(UNUSED_SETTLE_MS) ? this.#unusedRows().map((r) => ({ id: r.id, label: r.label })) : [],
      clickGuard: this.guard ? this.guard.status() : { locked: [], allSafe: true, unsure: [], protectedBuses: [], buses: [] },
      automix: this.automix ? { ...this.automix.status(), now: [...this.automix.describe(), ...(this.effects?.describe(this.library.songContext().names) ?? [])].sort((x, y) => Number(/^Song mix on/.test(x)) - Number(/^Song mix on/.test(y))) } : null,
      effects: this.effects ? { ...this.effects.status(), ask: this.fxAsk ?? null, note: this.fxNote ?? null, tweaks: Object.entries(REVERB_TWEAKS).map(([id, t]) => ({ id, label: t.label })) } : null,
      options: { nameChannels: this.settings.nameChannels !== false },
      tempo: this.tempo?.result ? { ...this.tempo.result, label: TEMPO_SOURCES[this.tempo.result.source] } : null,
      dcas: Object.values(this.state.dcas),
      walkin: this.#walkinStrips().map((id) => ({ id, fading: !!this.fades?.isFading(id), on: this.state.strips[id].on })),
      music: this.music ? this.music.status() : null,
      playlists: (this.settings.playlists ?? []).map((p) => ({ name: p.name })),
      alerts: this.alerts.slice(0, 20),
      roles: Object.fromEntries(Object.entries(ROLES).map(([k, v]) => [k, v.label])),
      // Only this computer's own screen is shown the PIN, so volunteers can read it off the Mac.
      pin: local ? this.pin : undefined,
      mac: local
        ? {
            update: this.updater?.status(),
            practice: !!this.practice,
            practicePort: this.config.practicePort ?? 8081,
            connection: {
              mode: this.settings.connection ?? 'auto',
              modes: CONNECTION_MODES,
              fixed: this.config.mixerHost !== 'auto', // set by config.json: the preference doesn't apply
              preferenceMet: this.preferenceMet !== false,
            },
            venues: (this.settings.venues ?? []).map((v) => ({ name: v.name, connection: v.connection, notes: v.notes })),
            venue: Number.isInteger(this.settings.venue) ? this.settings.venue : null,
          }
        : undefined,
      checklist: this.#checklist(),
      pa: this.#paSnapshot(),
      setlist: this.#setSnapshot(),
      addresses: local && this.boundPort ? this.#addressesForIpads().map((ip) => `http://${ip}:${this.boundPort}`) : undefined,
      // The Mac's Bonjour name (e.g. booth-mac.local) doesn't change week to week the way an address can.
      localName: local && this.boundPort ? `http://${macLocalName()}:${this.boundPort}` : undefined,
    };
  }

  /** This Mac's addresses, the one on the mixer's network first (that's the one iPads on the mixer Wi-Fi can reach). */
  #addressesForIpads() {
    const mixer = String(this.client?.hostIp ?? this.status.host ?? '');
    const prefix = mixer.split('.').slice(0, 3).join('.') + '.';
    const all = lanAddresses();
    return [...all.filter((ip) => mixer && ip.startsWith(prefix)), ...all.filter((ip) => !(mixer && ip.startsWith(prefix)))];
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
    if (os.hostname().toLowerCase() === h || `${os.hostname().toLowerCase()}.local` === h || macLocalName() === h) return true;
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
          this.handleCommand(cmd, { local: ws.isLocal });
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
    if (url.pathname === '/api/report') {
      if (!(this.config.trustLocalhost && isLoopback(req.socket.remoteAddress))) {
        res.writeHead(403);
        res.end('Reports can only be saved on the booth Mac.');
        return;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="mix-assistant-report-${stamp}.txt"` });
      res.end(this.report());
      return;
    }
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname === '/vendor/qrcode.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-cache' });
      fs.createReadStream(QR_SCRIPT).pipe(res);
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
