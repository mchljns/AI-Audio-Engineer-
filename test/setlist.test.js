import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library, instrumentFromPosition } from '../src/library.js';
import { PlanningCenter } from '../src/pco.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lib-')), n);

function band() {
  const lib = new Library(tmp('library.json'));
  const sarah = lib.savePerson({ name: 'Sarah', instruments: [{ type: 'vocal' }] });
  const mike = lib.savePerson({ name: 'Mike', instruments: [{ type: 'vocal' }, { type: 'acoustic', stereo: false }] });
  const ann = lib.savePerson({ name: 'Ann', instruments: [{ type: 'vocal' }, { type: 'keys' }] });
  const joe = lib.savePerson({ name: 'Joe', instruments: [{ type: 'electric' }] });
  lib.newSet({ title: 'Sunday' });
  lib.setLineup('vox1', sarah.id);
  lib.setLineup('vox2', mike.id);
  lib.setLineup('vox3', ann.id);
  lib.setLineup('acoustic', mike.id);
  lib.setLineup('keys', ann.id);
  lib.setLineup('electric', joe.id);
  return { lib, sarah, mike, ann, joe };
}

test('song mix: lead up, harmonies back, others down; mono/stereo channels', () => {
  const { lib, sarah, mike } = band();
  lib.addSong({ title: 'Goodness of God' });
  lib.setSongLeads(0, { lead: sarah.id, harmonies: [mike.id], leadInstrument: 'acoustic' });
  assert.deepEqual(lib.focusForCurrentSong(), {}, 'nothing until a song is played');
  lib.playSong(0);
  const f = lib.focusForCurrentSong();
  assert.equal(f['3'], 0, 'lead singer (Vox 1)');
  assert.equal(f['4'], -4, 'harmony (Vox 2)');
  assert.equal(f['5'], -10, 'singer not on this song (Vox 3)');
  assert.equal(f['6'], 0, 'lead instrument: acoustic, mono, left channel only');
  assert.equal(f['14'], undefined, "Mike's acoustic is mono, so the right channel isn't used");
  assert.equal(f['7'], -3, 'keys always stereo: both sides');
  assert.equal(f['8'], -3);
  assert.equal(f['12'], -3, 'electric always stereo');
  assert.equal(f['13'], -3);
});

test('stereo acoustic uses both channels', () => {
  const { lib, mike } = band();
  lib.savePerson({ ...lib.person(mike.id), instruments: [{ type: 'vocal' }, { type: 'acoustic', stereo: true }] });
  lib.addSong({ title: 'Song' });
  lib.setSongLeads(0, { leadInstrument: 'acoustic' });
  lib.playSong(0);
  const f = lib.focusForCurrentSong();
  assert.equal(f['6'], 0);
  assert.equal(f['14'], 0);
});

test('no lead chosen leaves the singers alone; next song walks the set', () => {
  const { lib } = band();
  lib.addSong({ title: 'A' });
  lib.addSong({ title: 'B' });
  lib.nextSong();
  assert.equal(lib.data.currentSong, 0);
  const f = lib.focusForCurrentSong();
  assert.equal(f['3'], 0);
  assert.equal(f['5'], 0);
  lib.nextSong();
  assert.equal(lib.data.currentSong, 1);
  lib.nextSong();
  assert.equal(lib.data.currentSong, null, 'after the last song: no song');
});

test('leads are remembered per song for next time', () => {
  const { lib, sarah, mike } = band();
  lib.addSong({ title: 'Way Maker' });
  lib.setSongLeads(0, { lead: mike.id, harmonies: [sarah.id], leadInstrument: 'keys' });
  lib.newSet({ title: 'Next week' });
  lib.setLineup('vox1', sarah.id);
  lib.setLineup('vox2', mike.id);
  lib.setLineup('keys', lib.data.people.find((p) => p.name === 'Ann').id);
  lib.addSong({ title: '  way   maker ' });
  const s = lib.set().songs[0];
  assert.equal(s.lead, mike.id);
  assert.deepEqual(s.harmonies, [sarah.id]);
  assert.equal(s.leadInstrument, 'keys');
});

test('Planning Center positions map to instruments', () => {
  const cases = { Vocals: 'vocal', 'Worship Leader': 'vocal', BGV: 'vocal', Keys: 'keys', Piano: 'keys', 'Acoustic Guitar': 'acoustic', 'Electric Guitar': 'electric', 'Lead Guitar': 'electric', Bass: 'bass', Drums: 'drums', Sound: null, Lyrics: null };
  for (const [p, t] of Object.entries(cases)) assert.equal(instrumentFromPosition(p), t, p);
});

test('importing a plan places people, skips declines, keeps song order', () => {
  const lib = new Library(tmp('library.json'));
  const { set, unplaced } = lib.importPlan({
    title: 'Sunday Service', date: 'Nov 9', serviceTypeId: '1', planId: '9',
    songs: [{ title: 'Song A', key: 'G', songId: '11' }, { title: 'Song B', key: 'D', songId: '12' }],
    team: [
      { name: 'Sarah', position: 'Vocals', status: 'C', personId: '501' },
      { name: 'Mike', position: 'Acoustic Guitar', status: 'C', personId: '502' },
      { name: 'Mike', position: 'Vocals', status: 'C', personId: '502' },
      { name: 'Ann', position: 'Keys', status: 'U', personId: '503' },
      { name: 'Declined Dave', position: 'Vocals', status: 'D', personId: '504' },
      { name: 'Joe', position: 'Electric Guitar', status: 'C', personId: '505' },
      { name: 'Extra', position: 'Electric Guitar', status: 'C', personId: '506' },
      { name: 'Sam', position: 'Sound', status: 'C', personId: '507' },
    ],
  });
  assert.deepEqual(set.songs.map((s) => s.title), ['Song A', 'Song B']);
  const nameAt = (slot) => lib.person(set.lineup[slot])?.name;
  assert.equal(nameAt('vox1'), 'Sarah');
  assert.equal(nameAt('vox2'), 'Mike');
  assert.equal(nameAt('acoustic'), 'Mike');
  assert.equal(nameAt('keys'), 'Ann');
  assert.equal(nameAt('electric'), 'Joe');
  assert.ok(!lib.data.people.some((p) => p.name === 'Declined Dave'));
  assert.ok(!lib.data.people.some((p) => p.name === 'Sam'), 'sound team is not on stage');
  assert.deepEqual(unplaced, ['Extra (Electric Guitar)']);
  const mike = lib.data.people.find((p) => p.name === 'Mike');
  assert.deepEqual(mike.instruments.map((i) => i.type).sort(), ['acoustic', 'vocal']);
  // Importing again matches people by Planning Center id, not duplicates.
  lib.importPlan({ title: 'Again', serviceTypeId: '1', planId: '10', songs: [], team: [{ name: 'Sarah J', position: 'Vocals', status: 'C', personId: '501' }] });
  assert.equal(lib.data.people.filter((p) => p.pcoId === '501').length, 1);
});

function fakePco(routes) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    const pathname = new URL(url).pathname + new URL(url).search;
    for (const [re, body, status = 200] of routes) if (re.test(pathname)) return { ok: status < 400, status, json: async () => body };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return { fetchImpl, calls };
}

test('Planning Center client: reads plans, songs in order, team; sends the token', async () => {
  const { fetchImpl, calls } = fakePco([
    [/service_types\?/, { data: [{ id: '1', attributes: { name: 'Sunday' } }] }],
    [/plans\?filter=future/, { data: [{ id: '9', attributes: { title: '', series_title: 'Advent', dates: 'Nov 9', sort_date: '2026-11-09' } }] }],
    [/plans\/9\/items/, { data: [
      { attributes: { item_type: 'song', title: 'Second', sequence: 3, key_name: 'D' }, relationships: { song: { data: { id: '12' } } } },
      { attributes: { item_type: 'header', title: 'Welcome', sequence: 1 } },
      { attributes: { item_type: 'song', title: 'First', sequence: 2, key_name: 'G' }, relationships: { song: { data: { id: '11' } } } },
    ] }],
    [/plans\/9\/team_members/, { data: [{ attributes: { name: 'Sarah', team_position_name: 'Vocals', status: 'C' }, relationships: { person: { data: { id: '501' } } } }] }],
    [/plans\/9$/, { data: { attributes: { title: 'Sunday Service', dates: 'Nov 9' } } }],
  ]);
  const pco = new PlanningCenter({ file: tmp('pco.json'), baseUrl: 'https://pco.test', fetchImpl });
  pco.saveToken('appid12345', 'secret67890');
  assert.equal((await pco.serviceTypes())[0].name, 'Sunday');
  assert.equal((await pco.upcomingPlans('1'))[0].title, 'Advent');
  const plan = await pco.plan('1', '9');
  assert.deepEqual(plan.songs.map((s) => s.title), ['First', 'Second'], 'songs only, in order');
  assert.equal(plan.team[0].personId, '501');
  assert.equal(calls[0].auth, `Basic ${Buffer.from('appid12345:secret67890').toString('base64')}`);
});

test('Planning Center client: plain-English errors', async () => {
  const bad = new PlanningCenter({ file: tmp('pco.json'), baseUrl: 'https://pco.test', fetchImpl: fakePco([[/./, {}, 401]]).fetchImpl });
  bad.saveToken('appid12345', 'secret67890');
  await assert.rejects(bad.serviceTypes(), /didn't accept the token/);
  const offline = new PlanningCenter({ file: tmp('pco.json'), baseUrl: 'https://pco.test', fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  offline.saveToken('appid12345', 'secret67890');
  await assert.rejects(offline.serviceTypes(), /on the internet/);
  assert.throws(() => offline.saveToken('x', 'y'), /doesn't look like/);
});

test('bridge: set commands from iPads, token Mac-only and never sent out, song button drives the mix', async (t) => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await new Promise((r) => setTimeout(r, 800));
  bridge.handleCommand({ type: 'pcoSaveToken', appId: 'appid12345', secret: 'secret67890' }, { local: false });
  assert.equal(bridge.snapshot().setlist.pco.configured, false, 'iPads cannot set the token');
  bridge.handleCommand({ type: 'pcoSaveToken', appId: 'appid12345', secret: 'secret67890' }, { local: true });
  const snap = JSON.stringify(bridge.snapshot({ local: true }));
  assert.ok(!snap.includes('secret67890') && !snap.includes('appid12345'), 'token never in what devices receive');

  await bridge.handleCommand({ type: 'savePerson', person: { name: 'Sarah', instruments: [{ type: 'vocal' }] } }, { local: false });
  const sarah = bridge.snapshot().setlist.people[0];
  await bridge.handleCommand({ type: 'newSet', title: 'Sunday' }, { local: false });
  await bridge.handleCommand({ type: 'setLineup', slotId: 'vox1', personId: sarah.id }, { local: false });
  await bridge.handleCommand({ type: 'addSong', title: 'Holy Forever' }, { local: false });
  await bridge.handleCommand({ type: 'setSongLeads', index: 0, lead: sarah.id, harmonies: [], leadInstrument: null }, { local: false });
  await bridge.handleCommand({ type: 'playSong', index: 0 }, { local: false });
  const sl = bridge.snapshot().setlist;
  assert.equal(sl.currentSong, 0);
  assert.equal(sl.current.songs[0].leadName, 'Sarah');
  assert.equal(bridge.automix.focus.get('3'), 0, 'song mix handed to the auto-mix');
  assert.equal(bridge.automix.mode, 'worship', 'song button starts worship straight away');
});
