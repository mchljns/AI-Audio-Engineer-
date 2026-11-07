// In-app updates: download the latest tested ("stable") version, install it next to the running
// one, swap it in, then exit so the background service restarts on the new version.
// The mixer keeps running the whole time; Mix Assistant is away for ~10-20 seconds.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';

const REPO = 'mchljns/AI-Audio-Engineer-';
const BRANCH = 'stable';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5 * 60 * 1000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${cmd} failed: ${String(stderr || err.message).trim().slice(-400)}`;
        reject(err);
      } else resolve(String(stdout));
    });
  });
}

/** Compare "1.2.3" versions. */
export function newerThan(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

export class Updater {
  /**
   * appDir: the running app folder (…/MixAssistant/app). Updates only work in an installed copy.
   * source: where to get versions (overridable for tests).
   */
  constructor({ appDir, currentVersion, nodeBin = process.execPath, exit = () => process.exit(0), source = {}, onAlert = () => {} }) {
    this.appDir = appDir;
    this.home = path.dirname(appDir);
    this.currentVersion = currentVersion;
    this.nodeBin = nodeBin;
    this.npmCli = path.join(path.dirname(path.dirname(nodeBin)), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
    this.exit = exit;
    this.onAlert = onAlert;
    this.versionUrl = source.versionUrl ?? `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`;
    this.tarballUrl = source.tarballUrl ?? `https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}`;
    this.state = { installed: Updater.isInstalledCopy(appDir), checking: false, updating: false, latest: null, available: false, error: null, step: null };
  }

  /** Only a copy put there by the installer (…/MixAssistant/app) updates itself. */
  static isInstalledCopy(appDir) {
    return path.basename(appDir) === 'app' && fs.existsSync(path.join(path.dirname(appDir), 'data'));
  }

  async check() {
    if (!this.state.installed) {
      this.state.error = 'Updates work in the installed copy on the booth Mac.';
      return this.status();
    }
    this.state.checking = true;
    this.state.error = null;
    try {
      const res = await fetch(this.versionUrl, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { version } = await res.json();
      this.state.latest = version;
      this.state.available = newerThan(version, this.currentVersion);
    } catch {
      this.state.error = "Couldn't check for updates. Is this Mac on the internet? (The mixer's own Wi-Fi has none.)";
    } finally {
      this.state.checking = false;
    }
    return this.status();
  }

  /** Download, install and swap in the new version, then restart. */
  async install() {
    if (!this.state.installed || this.state.updating) return this.status();
    this.state.updating = true;
    this.state.error = null;
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mix-update-'));
    const next = path.join(this.home, 'app.next');
    try {
      this.state.step = 'Downloading';
      const res = await fetch(this.tarballUrl, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
      const tgz = path.join(work, 'app.tgz');
      fs.writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));

      this.state.step = 'Unpacking';
      fs.rmSync(next, { recursive: true, force: true });
      fs.mkdirSync(next, { recursive: true });
      await run('tar', ['-xzf', tgz, '-C', next, '--strip-components=1']);
      if (!fs.existsSync(path.join(next, 'src', 'bridge.js'))) throw new Error("The download didn't look right.");

      this.state.step = 'Installing';
      const env = { ...process.env, PATH: `${path.dirname(this.nodeBin)}:${process.env.PATH ?? ''}` };
      await run(this.nodeBin, [this.npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: next, env });

      // Swap: keep the old copy until the new one is in place.
      this.state.step = 'Restarting';
      const old = path.join(this.home, 'app.old');
      fs.rmSync(old, { recursive: true, force: true });
      fs.renameSync(this.appDir, old);
      fs.renameSync(next, this.appDir);
      fs.rmSync(old, { recursive: true, force: true });
      this.onAlert({ level: 'ok', source: 'update', message: 'Update installed. Mix Assistant is restarting; this page reconnects by itself.' });
      setTimeout(() => this.exit(), 500); // the background service starts the new version
    } catch (err) {
      fs.rmSync(next, { recursive: true, force: true });
      this.state.error = `Update didn't finish: ${err.message}. Nothing was changed.`;
      this.state.updating = false;
      this.state.step = null;
      this.onAlert({ level: 'warn', source: 'update', message: this.state.error });
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
    return this.status();
  }

  status() {
    return { current: this.currentVersion, ...this.state };
  }
}
