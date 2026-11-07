import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import { Updater, newerThan } from '../src/updater.js';
import { Bridge } from '../src/bridge.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('version comparison', () => {
  assert.ok(newerThan('0.5.0', '0.4.9'));
  assert.ok(newerThan('1.0.0', '0.9.9'));
  assert.ok(!newerThan('0.4.2', '0.4.2'));
  assert.ok(!newerThan('0.4.1', '0.4.2'));
});

function fakeRelease(dir, version, { broken = false } = {}) {
  const top = path.join(dir, 'AI-Audio-Engineer--stable');
  fs.mkdirSync(path.join(top, 'src'), { recursive: true });
  fs.writeFileSync(path.join(top, 'package.json'), JSON.stringify({ name: 'mix', version }));
  fs.writeFileSync(path.join(top, 'package-lock.json'), JSON.stringify({ name: 'mix', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'mix', version } } }));
  if (!broken) fs.writeFileSync(path.join(top, 'src', 'bridge.js'), '// new version');
  execFileSync('tar', ['-czf', path.join(dir, 'app.tgz'), '-C', dir, 'AI-Audio-Engineer--stable']);
  return { version: JSON.stringify({ version }), tgz: fs.readFileSync(path.join(dir, 'app.tgz')) };
}

async function serve(t, rel) {
  const server = http.createServer((req, res) => {
    if (req.url === '/package.json') res.end(rel.version);
    else if (req.url === '/app.tgz') res.end(rel.tgz);
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { versionUrl: `${base}/package.json`, tarballUrl: `${base}/app.tgz` };
}

function installedCopy() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'MixAssistant-'));
  fs.mkdirSync(path.join(home, 'data'));
  fs.mkdirSync(path.join(home, 'app', 'src'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app', 'src', 'bridge.js'), '// old version');
  fs.writeFileSync(path.join(home, 'data', 'settings.json'), '{"pin":"123456"}');
  return home;
}

test('update: checks, installs, swaps and restarts; settings untouched', async (t) => {
  const rel = fakeRelease(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')), '9.9.9');
  const source = await serve(t, rel);
  const home = installedCopy();
  let exited = false;
  const u = new Updater({ appDir: path.join(home, 'app'), currentVersion: '0.4.2', source, exit: () => (exited = true) });
  const st = await u.check();
  assert.equal(st.latest, '9.9.9');
  assert.equal(st.available, true);
  await u.install();
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(fs.readFileSync(path.join(home, 'app', 'src', 'bridge.js'), 'utf8'), '// new version');
  assert.ok(!fs.existsSync(path.join(home, 'app.old')) && !fs.existsSync(path.join(home, 'app.next')));
  assert.equal(fs.readFileSync(path.join(home, 'data', 'settings.json'), 'utf8'), '{"pin":"123456"}');
  assert.ok(exited, 'restarts to load the new version');
});

test('update: a bad download changes nothing', async (t) => {
  const rel = fakeRelease(fs.mkdtempSync(path.join(os.tmpdir(), 'rel-')), '9.9.9', { broken: true });
  const source = await serve(t, rel);
  const home = installedCopy();
  let exited = false;
  const u = new Updater({ appDir: path.join(home, 'app'), currentVersion: '0.4.2', source, exit: () => (exited = true) });
  const st = await u.install();
  assert.match(st.error, /Nothing was changed/);
  assert.equal(fs.readFileSync(path.join(home, 'app', 'src', 'bridge.js'), 'utf8'), '// old version');
  assert.ok(!exited);
});

test('update: refuses outside an installed copy', async () => {
  const u = new Updater({ appDir: ROOT, currentVersion: '0.4.2' });
  const st = await u.check();
  assert.equal(st.installed, false);
  assert.match(st.error, /installed copy/);
});

test('Mac-only controls and reports are refused from iPads', async (t) => {
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: 9, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: '246810', trustLocalhost: false,
    protectedBuses: null, practicePort: 0,
  }).start();
  t.after(() => bridge.stop());
  await new Promise((r) => setTimeout(r, 200));
  bridge.handleCommand({ type: 'practice', on: true }, { local: false });
  assert.equal(bridge.snapshot({ local: true }).mac.practice, false, 'iPad cannot start practice mode');
  // trustLocalhost is off here, so this request counts as another device.
  const r = await fetch(`http://127.0.0.1:${bridge.boundPort}/api/report`);
  assert.equal(r.status, 403);
  assert.equal(bridge.snapshot().mac, undefined, 'iPads are not sent the This Mac card');
});

test('report from the booth Mac includes channels and alerts', async (t) => {
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: 9, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null,
  }).start();
  t.after(() => bridge.stop());
  await new Promise((r) => setTimeout(r, 200));
  const r = await fetch(`http://127.0.0.1:${bridge.boundPort}/api/report`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="mix-assistant-report-/);
  const text = await r.text();
  assert.match(text, /Mix Assistant .* report/);
  assert.match(text, /Channels/);
});

test('the downloadable installer contains the current install.sh and launcher', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  execFileSync('unzip', ['-q', path.join(ROOT, 'dist', 'Mix-Assistant-Installer.zip'), '-d', out]);
  const app = path.join(out, 'Mix Assistant Installer.app', 'Contents');
  assert.equal(fs.readFileSync(path.join(app, 'Resources', 'install.sh'), 'utf8'), fs.readFileSync(path.join(ROOT, 'install.sh'), 'utf8'), 'run scripts/build-mac-installer.sh');
  assert.equal(fs.readFileSync(path.join(app, 'MacOS', 'install'), 'utf8'), fs.readFileSync(path.join(ROOT, 'macos', 'installer-launch.sh'), 'utf8'), 'run scripts/build-mac-installer.sh');
  assert.ok(fs.statSync(path.join(app, 'MacOS', 'install')).mode & 0o111, 'launcher is executable');
});
