import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toSpotifyUri, scriptFor, asString, explainError, fakePlayer, MusicController } from '../src/music.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';
import { paths } from '../src/xair/addresses.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(50);
  }
  return false;
}

test('Spotify links are turned into URIs; anything else is refused', () => {
  assert.equal(toSpotifyUri('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=abc'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(toSpotifyUri('https://open.spotify.com/intl-de/album/4aawyAB9vmqN3uQ7FjRGTy'), 'spotify:album:4aawyAB9vmqN3uQ7FjRGTy');
  assert.equal(toSpotifyUri('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
  for (const bad of ['', 'hello', 'https://evil.example/playlist/123', 'spotify:playlist:abc" & do shell script "rm -rf ~']) assert.equal(toSpotifyUri(bad), null, bad);
});

test('AppleScript strings are quoted safely', () => {
  assert.equal(asString('Sunday "Best"'), '"Sunday \\"Best\\""');
  assert.equal(asString('a\\b'), '"a\\\\b"');
  const script = scriptFor('music', 'playList', 'x" & do shell script "say hi');
  assert.ok(script.includes('play playlist "x\\" & do shell script \\"say hi"'), script);
});

test('status check never opens the app', () => {
  assert.match(scriptFor('spotify', 'status'), /if application "Spotify" is running then/);
});

test('macOS errors are explained in plain English', () => {
  assert.match(explainError({ stderr: 'execution error: Not authorized to send Apple events to Spotify. (-1743)' }, 'Spotify'), /Privacy & Security → Automation/);
  assert.match(explainError({ code: 'ENOENT', message: 'spawn osascript ENOENT' }, 'Spotify'), /booth Mac/);
});

test('controller drives the player and reports what is playing', async () => {
  const fake = fakePlayer();
  const m = new MusicController({ runner: fake.runner, checkInternet: async () => false }).start();
  await m.command('playList', 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M');
  assert.equal(m.status().playing, true);
  assert.equal(m.status().track, 'Walk-in Song One');
  await m.command('next');
  assert.equal(m.status().track, 'Walk-in Song Two');
  await m.command('pause');
  assert.equal(m.status().playing, false);
  await wait(50);
  assert.equal(m.status().internet, false);
  m.stop();
});

test('walk-in: one tap starts the playlist and fades up; one tap fades out and pauses', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const fake = fakePlayer();
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 0.5,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false,
    trustLocalhost: true, protectedBuses: null, musicApp: 'spotify', musicRunner: fake.runner,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await until(() => bridge.status.connected && bridge.state.strips.aux.name === 'Walk-in');
  await wait(600);

  bridge.handleCommand({ type: 'addPlaylist', name: 'Bad', link: 'not a link' });
  assert.equal(bridge.snapshot().playlists.length, 0, 'bad link refused');
  bridge.handleCommand({ type: 'addPlaylist', name: 'Sunday walk-in', link: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(bridge.snapshot().playlists, [{ name: 'Sunday walk-in' }]);

  // Start from silence.
  bridge.handleCommand({ type: 'setOn', id: 'aux', on: false });
  await wait(100);
  bridge.handleCommand({ type: 'walkinStart', playlist: 0 });
  assert.ok(await until(() => fake.st.playing && sim.get(paths.on('aux')) === 1), 'playing and channel on');
  assert.ok(fake.calls.some((c) => c.includes('play track "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"')));
  assert.ok(await until(() => !bridge.fades.isFading('aux')), 'fade-up finished');

  bridge.handleCommand({ type: 'walkinEnd' });
  assert.ok(await until(() => sim.get(paths.on('aux')) === 0), 'faded out and muted');
  assert.ok(await until(() => fake.st.playing === false, 3000), 'player paused after the fade');
});

test('player buttons work even while the mixer is offline', async (t) => {
  const fake = fakePlayer();
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: 9, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false,
    trustLocalhost: true, protectedBuses: null, musicApp: 'spotify', musicRunner: fake.runner,
  }).start();
  t.after(() => bridge.stop());
  await bridge.handleCommand({ type: 'music', action: 'play' });
  assert.equal(fake.st.playing, true);
});
