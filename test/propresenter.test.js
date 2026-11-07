import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Library } from '../src/library.js';
import { ProPresenter, validProHost, presentationName } from '../src/propresenter.js';
import { XR18Simulator } from '../src/simulator/xr18-sim.js';
import { Bridge } from '../src/bridge.js';

/** Wait until check() is true (ProPresenter is polled once a second), up to 5 s. */
async function until(check) {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((r) => setTimeout(r, 100));
}
const settle = () => new Promise((r) => setTimeout(r, 1300)); // for "nothing should change"
const tmp = (n) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pro-')), n);

test("this week's channels: a position moves for one set only, and the song mix follows", () => {
  const lib = new Library(tmp('library.json'));
  const sarah = lib.savePerson({ name: 'Sarah', instruments: [{ type: 'vocal' }] });
  const ann = lib.savePerson({ name: 'Ann', instruments: [{ type: 'vocal' }, { type: 'keys' }] });
  lib.newSet({ title: 'Week 1' });
  lib.setLineup('vox1', sarah.id);
  lib.setLineup('vox2', ann.id);
  lib.setLineup('keys', ann.id);
  lib.addSong({ title: 'Holy Forever' });
  lib.setSongLeads(0, { lead: ann.id, harmonies: [], leadInstrument: 'keys' });
  lib.setSetChannel('vox1', '9'); // Sarah is on pack 3 this week
  lib.setSetChannel('keys', '10', '11');
  lib.playSong(0);
  const f = lib.focusForCurrentSong();
  assert.equal(f['9'], -10, "Sarah's mic this week");
  assert.equal(f['3'], undefined, 'her usual channel is left alone');
  assert.equal(f['10'], 0, 'keys left this week');
  assert.equal(f['11'], 0, 'keys right this week');
  assert.equal(f['7'], undefined);
  lib.setSetChannel('vox1', 'bogus');
  assert.equal(lib.set().channels.vox1, undefined, 'bad channel clears back to usual');
  lib.setSetChannel('vox1', '', '');
  lib.newSet({ title: 'Week 2' });
  assert.deepEqual(lib.set().channels, {}, 'a new week starts from the usual channels');
  assert.equal(lib.slot('vox1').left, '3', 'the usual channel is unchanged');
});

test('ProPresenter song names match songs in the set loosely', () => {
  const lib = new Library(tmp('library.json'));
  lib.newSet({ title: 'Sunday' });
  for (const t of ['Holy Forever', 'Goodness of God', 'Firm Foundation (He Won’t)', 'King of Kings']) lib.addSong({ title: t });
  assert.equal(lib.matchSong('Holy Forever'), 0);
  assert.equal(lib.matchSong('holy forever (Live)'), 0);
  assert.equal(lib.matchSong('Goodness Of God - Bethel'), 1);
  assert.equal(lib.matchSong('Firm Foundation'), 2);
  assert.equal(lib.matchSong('King of Kings [B]'), 3);
  assert.equal(lib.matchSong('Welcome / Announcements'), -1);
  assert.equal(lib.matchSong('Sermon'), -1);
  assert.equal(lib.matchSong(''), -1);
});

test('ProPresenter address must be on the local network', () => {
  assert.equal(validProHost('192.168.1.20'), '192.168.1.20');
  assert.equal(validProHost('10.0.0.5'), '10.0.0.5');
  assert.equal(validProHost('172.20.1.1'), '172.20.1.1');
  assert.equal(validProHost('Media-Mac.local'), 'media-mac.local');
  assert.equal(validProHost('8.8.8.8'), null);
  assert.equal(validProHost('example.com'), null);
  assert.equal(validProHost('192.168.1.300'), null);
  assert.equal(validProHost('http://192.168.1.2'), null);
  assert.equal(presentationName({ presentation: { id: { uuid: 'x', name: 'Holy Forever', index: 0 } } }), 'Holy Forever');
  assert.equal(presentationName({ presentation: { name: 'Holy Forever' } }), 'Holy Forever');
  assert.equal(presentationName({ presentation: null }), null);
  assert.equal(presentationName(null), null);
  const pro = new ProPresenter({ file: tmp('pro.json') });
  assert.throws(() => pro.configure({ host: 'example.com', port: '1025' }), /isn't a computer on this network/);
  assert.throws(() => pro.configure({ host: '192.168.1.20', port: 'abc' }), /port number/);
  pro.configure({ host: '192.168.1.20', port: '1025', follow: true });
  assert.deepEqual(new ProPresenter({ file: pro.file }).settings, { host: '192.168.1.20', port: '1025', follow: true }, 'saved');
  pro.configure({ host: '', port: '' });
  assert.equal(pro.settings.follow, false, 'removing the address turns following off');
});

test('bridge follows ProPresenter: the song that goes up becomes the current song and drives the mix', async (t) => {
  let live = null;
  let up = true;
  const asked = [];
  const proFetch = async (url) => {
    asked.push(url);
    if (!up) throw new Error('ECONNREFUSED');
    return { ok: true, status: 200, json: async () => ({ presentation: live ? { id: { uuid: 'u', name: live, index: 0 } } : null }) };
  };
  const port = 20000 + Math.floor(Math.random() * 20000);
  const sim = await new XR18Simulator({ port }).start();
  const bridge = await new Bridge({
    mixerHost: '127.0.0.1', mixerPort: port, httpPort: 0, walkinFadeSeconds: 1,
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'mix-')), keepAwake: false, pin: false, trustLocalhost: true, protectedBuses: null, proFetch,
  }).start();
  t.after(() => {
    bridge.stop();
    sim.stop();
  });
  await new Promise((r) => setTimeout(r, 800));
  const cmd = (c) => bridge.handleCommand(c, { local: false });
  await cmd({ type: 'savePerson', person: { name: 'Sarah', instruments: [{ type: 'vocal' }] } });
  const sarah = bridge.snapshot().setlist.people[0];
  await cmd({ type: 'newSet', title: 'Sunday' });
  await cmd({ type: 'setLineup', slotId: 'vox1', personId: sarah.id });
  await cmd({ type: 'setSetChannel', slotId: 'vox1', left: '9', right: '' });
  await cmd({ type: 'addSong', title: 'Holy Forever' });
  await cmd({ type: 'addSong', title: 'Goodness of God' });
  await cmd({ type: 'setSongLeads', index: 1, lead: sarah.id, harmonies: [] });

  await cmd({ type: 'proPresenter', host: 'example.com', port: '1025' });
  assert.equal(bridge.snapshot().setlist.pro.host, '', 'an internet address is refused');
  await cmd({ type: 'proPresenter', host: '192.168.1.20', port: '1025', follow: true });

  live = 'Goodness of God (Live)';
  await until(() => bridge.snapshot().setlist.currentSong === 1);
  let sl = bridge.snapshot().setlist;
  assert.ok(asked.some((u) => u === 'http://192.168.1.20:1025/v1/presentation/current'));
  assert.equal(sl.currentSong, 1, 'moved to the song ProPresenter put up');
  assert.equal(sl.pro.connected, true);
  assert.equal(sl.pro.match.song, 'Goodness of God');
  assert.equal(bridge.automix.focus.get('9'), 0, "song mix uses this week's channel");
  assert.equal(bridge.automix.mode, 'worship');

  live = 'Announcements';
  await until(() => bridge.snapshot().setlist.pro.match?.name === 'Announcements');
  sl = bridge.snapshot().setlist;
  assert.equal(sl.currentSong, 1, 'non-song slides change nothing');
  assert.equal(sl.pro.match.song, null);

  await cmd({ type: 'playSong', index: 0 });
  await cmd({ type: 'proPresenter', follow: false });
  live = 'Goodness of God';
  await settle();
  assert.equal(bridge.snapshot().setlist.currentSong, 0, 'not following: the engineer is in charge');

  await cmd({ type: 'proPresenter', follow: true });
  await until(() => bridge.snapshot().setlist.currentSong === 1);
  assert.equal(bridge.snapshot().setlist.currentSong, 1, 'switching on catches up with the song that is up');
  await cmd({ type: 'playSong', index: 0 }); // engineer picks a song by hand
  up = false;
  await until(() => !!bridge.snapshot().setlist.pro.error);
  sl = bridge.snapshot().setlist;
  assert.equal(sl.pro.connected, false);
  assert.match(sl.pro.error, /Can't reach ProPresenter/);
  assert.equal(sl.currentSong, 0, 'losing ProPresenter changes nothing');
  up = true;
  await until(() => bridge.snapshot().setlist.pro.connected);
  await settle();
  assert.equal(bridge.snapshot().setlist.currentSong, 0, "reconnecting to the same slide doesn't undo the engineer's choice");
});

test('this week: a singer without an instrument, a player who does not sing, and switching either', () => {
  const lib = new Library(tmp('library.json'));
  const mike = lib.savePerson({ name: 'Mike', instruments: [{ type: 'vocal' }, { type: 'acoustic' }] });
  const sarah = lib.savePerson({ name: 'Sarah', instruments: [{ type: 'vocal' }] });
  const joe = lib.savePerson({ name: 'Joe', instruments: [{ type: 'electric' }] });
  lib.newSet({ title: 'Sunday' });
  assert.ok(lib.placePerson(sarah.id, 'vocal', true), 'Sarah only sings');
  assert.ok(lib.placePerson(joe.id, 'electric', true), 'Joe only plays');
  assert.ok(lib.placePerson(mike.id, 'acoustic', true), 'Mike only plays this week');
  const lineup = lib.set().lineup;
  assert.equal(Object.values(lineup).filter((p) => p === mike.id).length, 1, 'Mike has no mic this week');
  assert.ok(lib.placePerson(mike.id, 'acoustic', true), 'placing twice is harmless');
  assert.equal(Object.values(lib.set().lineup).filter((p) => p === mike.id).length, 1);

  lib.addSong({ title: 'Holy Forever' });
  lib.setSongLeads(0, { lead: mike.id, harmonies: [] }); // remembered from a week he sang
  lib.playSong(0);
  assert.equal(lib.focusForCurrentSong()['3'], 0, "a lead who isn't singing this week doesn't pull Sarah down");

  assert.ok(lib.placePerson(mike.id, 'vocal', true), 'Mike sings after all');
  const f = lib.focusForCurrentSong();
  assert.equal(f[lib.data.slots.find((x) => lib.set().lineup[x.id] === mike.id && x.instrument === 'vocal').left], 0, 'now he leads');
  assert.equal(f['3'], -10, 'Sarah sits back');
  assert.ok(lib.placePerson(mike.id, 'vocal', false));
  assert.equal(Object.values(lib.set().lineup).filter((p) => p === mike.id).length, 1, 'mic taken away, acoustic kept');
  for (const n of ['A', 'B', 'C', 'D']) lib.placePerson(lib.savePerson({ name: n, instruments: [{ type: 'vocal' }] }).id, 'vocal', true);
  assert.equal(lib.placePerson(mike.id, 'vocal', true), false, 'no free vocal mic');
});

test("channels are set once a week: each new set needs checking, and starts from each person's last channel", () => {
  const lib = new Library(tmp('library.json'));
  const sarah = lib.savePerson({ name: 'Sarah', instruments: [{ type: 'vocal' }] });
  const ann = lib.savePerson({ name: 'Ann', instruments: [{ type: 'vocal' }, { type: 'keys' }] });
  lib.newSet({ title: 'Week 1' });
  assert.equal(lib.set().channelsDone, false, 'needs checking');
  lib.placePerson(sarah.id, 'vocal', true); // Vox 1
  lib.placePerson(ann.id, 'keys', true);
  lib.setSetChannel('vox1', '10');
  lib.setSetChannel('keys', '11', '12');
  lib.setChannelsDone(true);
  assert.equal(lib.set().channelsDone, true);
  lib.addSong({ title: 'A' });
  lib.addSong({ title: 'B' });
  lib.playSong(0);
  const a = lib.focusForCurrentSong();
  lib.playSong(1);
  assert.deepEqual(Object.keys(lib.focusForCurrentSong()).sort(), Object.keys(a).sort(), 'same channels for every song');

  lib.newSet({ title: 'Week 2' });
  assert.equal(lib.set().channelsDone, false, 'next week needs checking again');
  lib.placePerson(ann.id, 'vocal', true); // Ann takes Vox 1 this week
  lib.placePerson(sarah.id, 'vocal', true); // Sarah on Vox 2
  lib.placePerson(ann.id, 'keys', true);
  assert.equal(lib.set().channels.vox1, undefined, "Ann has never sung on a set channel: Vox 1's usual channel, not Sarah's");
  assert.deepEqual(lib.set().channels.vox2, { left: '10', right: '' }, "Sarah starts on last week's channel");
  assert.deepEqual(lib.set().channels.keys, { left: '11', right: '12' }, "Ann's keys start on last week's channels");
  lib.placePerson(sarah.id, 'vocal', false);
  assert.equal(lib.set().channels.vox2, undefined, "taking someone off clears their channel from the position");
});
