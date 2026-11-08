# Church Mix Assistant

An assistant for a Behringer XR18 at a small church. A small **bridge** program runs on the booth Mac (the one that already plays the pre- and post-service music). It talks to the mixer over the network, and volunteers use the **web app** from any iPad, phone or computer on the same network.

It works alongside the Behringer X Air app, which stays available as a backup.

## The auto-mix

## Look and feel

Mix Assistant looks like the console gear it drives, not a generic web app: a near-black booth-friendly canvas with panels divided by hairlines, keys that light up when they're on, segmented LED meters (green, then amber, then red), a colour block per person showing their role on the song (gold lead, cyan harmony, copper lead instrument), and labels set like the printing on hardware. The typeface is Barlow / Barlow Condensed (SIL Open Font License), bundled with the app so it works with no internet. Icons are simple line icons, no emoji.

## For volunteers

The app is built for people who aren't sound engineers.

- **A welcome on each device, the first time it opens Mix Assistant.** On the booth Mac (about 5 minutes, for the tech lead): find the mixer, name the place you meet, which channel each stage position uses, connect the iPads with the QR code, then Planning Center and ProPresenter (both optional). On an iPad (about a minute): keep it on the Home Screen, who uses this iPad (a volunteer, or the tech lead for Tech mode), and four things to know (Get ready, Live, the status light, Hands off). Every step can be skipped; ⚙︎ → *Show the welcome again* runs it any time.
- **Get ready** (the first tab) walks through Sunday morning in order, with a progress bar: set up the gear (a short checklist, with the speaker marks from last time), this week's songs and people, who is on which channel (with *Find* by listening), levels one person at a time (*Listen*: they sing or play their loudest for 7 seconds), who sings lead on each song, and an optional "anything sound wrong?" step. Every iPad sees the same progress; a new week starts fresh.
- **Live** has what's needed during the service: the song buttons (or *Follow ProPresenter*), the parts of the service, what Mix Assistant is doing in plain words, and the pre/post-service music.
- **Songs & people** is for changes: the channels and roles cards, editing the set, Planning Center, people.
- **The status light** at the top of every screen is green ("All good. Mix Assistant is mixing"), yellow (needs a look, in words) or red (act now). Tap it for the details and recent messages.
- **✋ Hands off** at the top of every screen: one tap puts every fader and effect back where people set them and stops Mix Assistant changing anything, until someone taps *Turn Mix Assistant back on*. It stays paused even if the Mac restarts.
- **Plain words:** results are described as outcomes ("less muddy · evened out (medium)", "band down a touch"), not numbers. In a person's Tone, **Before / After** lets you hear whether a fix helped.
- **Tech mode** (⚙︎, top right) is for the tech lead: effects setup, the mixer console, PA setup, ProPresenter, channels for each position, network and updates, and a one-time setup checklist. Volunteers don't need it.

The **Live** screen (Tech mode shows more detail). It listens to the channel meters and mixes the service by itself:

- **Balances the speech mics.** Whoever is talking (pastor, announcements) stays up; the other speech mic comes down, so there's less hiss and less feedback. Between sentences the last talker stays up.
- **Knows where the service is.** Before / after (pre- and post-service music) → Worship → Talking over music → Speaking, worked out from which channels are making sound. Big buttons let a volunteer set the mode instead.
- **Turns the band and tracks down under talking** during announcements and prayer over music, and brings them back smoothly.
- **Turns unused singer mics down in the room during the sermon** (after 20 seconds of speaking), and brings them back the moment music starts or someone talks into one.
- **Keeps the lead singer on top during worship (vocal riding).** It learns each singer's and the band's normal level. When the lead (the song's lead singer, or whoever is carrying the song) gets quiet, it brings them up, and if that isn't enough, the band comes down. When they belt, it eases them back. It moves only as much as needed, up to the strength you pick on the Auto screen: **Off, Gentle ±2, Normal ±4 (default) or Strong ±6 dB**. A full chorus favours nobody.
- **Harmonies stay the same size:** with two or three harmony singers on a song, each comes down 3 dB per doubling (−10·log10 N), so a bigger group doesn't get louder than one harmony.
- **Follows the song's sections** (with ProPresenter): in verses, pre-choruses and intros the band sits 1.5 dB under its level to leave room for the lead vocal; choruses, the bridge and tags come back up, with the reverb 2 dB lower.
- **Bass weeks:** put a bassist on the Bass position. When they're playing steadily during worship, keys get a 120 Hz and acoustic a 110 Hz low cut (between songs), so the low end doesn't pile up; after 30 s of no bass it all goes back, and the keys carry the low end again.
- **Catches feedback** (Auto → *Catch feedback*): it watches the mixer's 100-band analyzer for a lone tone that keeps growing (music has harmonics and holds steady, so it's ignored). The mic that's ringing comes down 3 dB for 10 s and gets a narrow −4 dB cut at that frequency (deeper, up to −8, if it rings again). If it can't tell which mic yet, every open mic comes down 3 dB until it can. A cut that isn't needed for 5 minutes is lifted 1 dB a minute until it's gone.
- **Says what it's doing, live:** "Keeping Sarah on top: Sarah +4 dB, band −1.5 dB", "Music −8 dB under the talking", "Pastor talking: other speech mics down". On the Auto screen and along the top of the Set tab.
- **Handles the effects.** The pastor's mic is always kept dry (no reverb or delay), and announcement mics are too by default. The reverb and delay come down about 6 dB while someone talks between songs or over music, and about 15 dB for the sermon and pre/post-service music, then go back for worship. Only the effects' level in the room moves, so singers keep their reverb in the in-ears. On songs marked **Light delay** (at soundcheck), the lead singer gets a light delay during the song and none the rest of the time. **Auto by tempo** (the default) uses a short 1/16 delay with little feedback on songs from 100 BPM and a dotted-1/8 throw on slower ones. Once the app runs the reverb, each song gets a decay of about a half note (1.2–2 s) and a pre-delay of about a 1/32 note (40–80 ms); your reverb fixes are kept on top. A singer who talks between songs has their own reverb send taken to zero at once, and back when the singing starts. The delay time comes from the song's tempo, **heard live**: from the click when tracks are running (within about half a BPM), otherwise the tracks' stems or a steady strum, and only once the beat is steady. A steady tempo is remembered for that song; Planning Center's tempo or **Tap tempo** are used until it's heard (and to tell an eighth-note click from a fast song). Choose dotted 1/8 (usual), 1/4 or 1/8 under Effects. **Let Mix Assistant run the effects** (Set tab → Effects): one tap sets up the reverb as a vocal plate (pre-delay 30 ms, decay 1.6 s, low cut 250 Hz, high cut 6.5 kHz) or the delay as a stereo delay (100% wet, 20% feedback, filtered). The app then asks you to check once in X Air that it shows those settings. *Yes*: from then on the app runs that effect. The reverb buttons (*Washy*, *Muddy*, *Splashy*, *Like a cave*, *Too short*, *Dull*) change the reverb directly in small, bounded steps with undo, and the delay's time follows each song's tempo. *No*: it tries another way, and if that fails it puts back exactly what was there. Each singer's reverb (Dry / A little / Normal / More) and delay (Never / Light / More) are set in their 🎚 Tone and saved with it. Set tab → **Effects** has *Too much reverb* / *Can't hear the reverb* buttons, plain-English fixes for a reverb that sounds washy, muddy, splashy or too long, and good starting settings.
- **It never touches the in-ear mixes, and can't.** Every write to the mixer passes one guard that blocks anything on an aux bus, any channel's or effect's send to the in-ear mixes, snapshot loads, mixer setup and phantom power, whatever any other part of the app asks for (the only exception is a bus you list as "protected" in config.json, which the click guard keeps clear). It only moves channel faders and never mutes, so with pre-fader aux sends (the XR18 setting for in-ears) the band's mixes don't change.
- Everything except vocal riding only turns things **down** from where a person set them. Vocal riding may turn the **lead singer** up, with limits: vocal mics only, worship only, only while they're singing (it comes off within about 0.3 s when they stop), never past the chosen limit or +6 dB on the fader, and if a boosted mic's level starts climbing by itself (feedback), the boost comes off at once and that mic gets no boosts for a minute. Speech mics, the pastor and music are never turned up. Moving any fader (here or in the X Air app) sets that channel's new level. Each feature has its own off switch. If the app restarts, it puts everything back first.

A **Mixer** tab has the full console view for anything else.

## Pre/post-service music from the iPad

The Pre/post-service music card controls **Spotify** on the booth Mac, so nobody has to touch the Mac on Sunday:
- **Fade music in** (before the service, and again after it): plays the chosen playlist and fades the music channel up.
- **Fade music out** (when the service starts, or once the room has emptied): fades the music channel out, then pauses Spotify.
- Previous / play-pause / next, and what's playing now.
- Save playlists once: in Spotify use **Share → Copy link to playlist**, then paste it under "Add a playlist".

The first time, macOS asks whether "node" may control Spotify: click **OK** (or turn it on later in System Settings → Privacy & Security → Automation). To use Apple Music instead, add `"musicApp": "music"` to `config.json`; playlists are then saved by name.

See [docs/NETWORK.md](docs/NETWORK.md) for keeping Spotify working while the iPads are on the mixer's Wi-Fi.

## What else it does

- **Connects to the XR18** automatically and keeps a live copy of every channel's name, mute, fader, main assign, FX sends and level.
- **Channel inventory.** Reads the channel names and works out what each channel is (pastor, singer, keys, track, click…). Combined with live signal, it shows what's in use, what's named but silent (dead battery?), and what has signal but no name.
- **Click & guide lock.** Channels named Click/Guide (or confirmed as such) are kept out of the house:
  - Main L/R assign is forced off.
  - Sends to FX1–4 are forced to zero, because effects returns feed the house.
  - Aux buses (the in-ear mixes) are never changed. If you ever add a livestream or recording feed on an aux, list it in `config.json` as `"protectedBuses": [6]` and the click is kept off that one bus.
  - It watches for changes from any app or scene recall and undoes them within moments, with an alert.
  - **The lock is sticky.** If someone renames the Click channel, it stays protected and the volunteer is warned, until a person sets what the channel is now.
- **Mute unused channels** with one tap. Only touches channels with no name and no signal, never click/guide. This helps the noise floor.
- **Pre/post-service music.** Fades out smoothly when the service starts, and back in to its saved level after the service. If someone grabs the fader during a fade, the fade stops and the person wins.
- **PIN for other devices.** iPads and phones enter a 4-digit PIN once (shown at the top of the app on the booth Mac). Five wrong tries locks that device out for a minute. The booth Mac itself never needs it.
- **Console-style mixer view**: side-by-side channel strips with fader, meter, mute, main (LR) assign and a colour-coded name strip, plus the 4 DCA groups at the right. Faders move relative to your finger, so touching one never makes it jump. Tap a name strip to see what the app thinks the channel is, or to change it. The pre-service check and alerts fold away above the strips.
- **Confirm a channel's role** when the name is unclear (e.g. "Sarah"). The answer is remembered, but only while the channel keeps that name. Rename it, and the app reads the new name again.

## Try it without the mixer

You need [Node.js](https://nodejs.org) 20 or newer (runs natively on Apple silicon Macs).

```bash
npm install
npm run dev
```

Open http://localhost:8081. This runs a simulated XR18 with the church layout, playing a pretend service on a loop (pre-service music, worship, announcements, sermon, post-service music) so you can watch the auto-mix work. To watch the click lock work, run `npm run dev -- --chaos`: every 20 seconds the simulator pretends someone routed the click or guide into the house.

```bash
npm test
```

## Install on the booth Mac

**[Download Mix Assistant](https://github.com/mchljns/AI-Audio-Engineer-/raw/stable/dist/Mix-Assistant-Installer.zip)**, then double-click **Mix Assistant Installer** in Downloads and click **Install**. No Terminal needed.

The first time, macOS says it can't verify the installer (it isn't signed with a paid Apple developer certificate). Click **Done**, open **System Settings → Privacy & Security**, click **Open Anyway** next to "Mix Assistant Installer", confirm, and click **Open**.

It takes about two minutes, needs the internet while installing, and needs no administrator password. It:
- puts everything in a **MixAssistant** folder in your home folder, including its own copy of Node.js, so nothing else on the Mac is touched
- runs Mix Assistant **in the background**, starting by itself whenever someone logs in to the Mac, and restarting itself if it ever crashes (macOS may show a "Background Items Added" notice)
- adds a **Mix Assistant** app (in Applications in your home folder, with a shortcut on the Desktop) that opens it
- opens Mix Assistant when it's done

**Updates, practice mode and troubleshooting reports** are buttons in the app's **This Mac** card (shown only on the Mac itself). Running the installer again also updates. Settings are always kept. It installs the **stable** version: the last one tested on the real mixer.

### The Set tab: people, Planning Center and a song button per song

- **Channels for each position:** each stage position (Vox 1–4, Keys, Acoustic, Electric, or any you add) has its XR18 channel numbers. Keys and electric are always stereo pairs; acoustic has a second channel that's only used when that person's acoustic is stereo.
- **People:** who plays or sings what, including mono or stereo acoustic per person. People from Planning Center are added automatically and matched by their Planning Center ID next time.
- **Planning Center:** a Planning Center admin creates a Personal Access Token; enter its app ID and secret on the booth Mac (it stays there, and Mix Assistant only reads). Choose a service type and import an upcoming plan: songs come in order with their keys, and people are placed on positions by their Planning Center position (Vocals, Keys, Acoustic Guitar, Electric Guitar…). Needs internet, so import during the week; the set is kept for Sunday.
- **Set wizard:** confirm who's on which position, then for each song pick the **lead singer**, **harmonies** and **lead instrument**. These are remembered per song and filled in automatically the next time it's in a set (when those people are on).
- **Soundcheck view** (Set tab → **Soundcheck: set roles**), for setting roles while hearing each song the first time in the morning: one big card per song with ◀ ▶, and one row per person on stage, so someone who sings and plays has both on the same row. Each singer has **Sings: Lead / Harmony / Off** (picking a new lead moves the old one to harmony), and each instrument has a **★ Lead** button for the instrument that carries the song. Every mic and instrument shows its live level, so you can see who's playing and singing. **Who does what this week:** chips under each name say whether they sing and which of their instruments they play this week (a singer with no instrument, a player who doesn't sing, or both); tap to change, and **+ Add someone to this set** brings in anyone not on the lineup. A song's remembered lead who isn't on a mic this week is ignored, so nobody gets pulled down for it. **Input gain:** in each person's 🎚 Tone, **Set gain** listens for 7 seconds while they sing or play their loudest part, then sets the XR18's preamp gain so it peaks around −15 dB (the −18 to −12 sweet spot). The compressor and gate thresholds move with it. At most 12 dB per press, and phantom power is never touched. Gain is saved with their tone.

**Channel names:** when you tap *Channels are set*, Mix Assistant names this week's channels on the mixer after the people on them ("Sarah Vox", "Joe EG L"), so X Air matches. A name is only used if it reads back as the right kind of channel ("Ann" would look like announcements, so she gets "Vox A."). Click and guide are never renamed. There's a switch to turn this off.

**Tone (EQ, compression, hiss) per person:** every mic and instrument row has a **🎚 Tone** button. It reads that channel's current low cut, EQ, compressor and gate from the mixer (so anything set in X Air is respected) and offers plain-language fixes for what you hear: for vocals *Boomy / pops, Muddy, Thin, Boxy, Nasal, Buried / unclear, Harsh, Sharp S's, Dull*; acoustic, keys and electric have their own (*Quacky*, *Fizzy*, *Make room for vocals*…). Each tap is a small step at the right frequency (usually 2 dB), with a limit, and taps add up. **Compression: Off / Light / Medium / Firm** listens for 7 seconds while they sing their loudest part and sets the threshold so the loudest lines get about 3, 5 or 8 dB of squeeze. **Turn hiss down between lines** measures the mic's hiss for 4 seconds of quiet and sets a gentle expander just above it (EXP2, 300 ms hold), so the hiss fades down between lines without chopping words (for wireless-pack hiss). **"P" and "B" pops:** try *Boomy / pops* first (a higher low cut). For a singer who still pops, **Catch pops** listens to their loudest singing and sets their compressor to listen only below 150 Hz with a 1 ms reaction, so a pop ducks the channel for an instant and normal singing passes. *Still popping* / *Low notes dip* move it 3 dB; it replaces their normal compression. **Undo**, **Start fresh**, and **Save to Sarah**: a saved tone loads onto whatever channel they're on each week when you tap *Channels are set*. EQ and compression are on the channel, so they also change that person in the in-ears; in-ear levels are never touched.

**This week's channels** (top of the soundcheck view): channels don't change from song to song, but they're set every week. Each person's mic and instrument is listed with its channel, starting from the channel that person used last time. Not sure? Tap **Find**, have them sing or play for a few seconds, and the channel that lights up is picked (stereo instruments get the pair). Find ignores what was already playing (click, tracks, other people) and channels someone else is using. Tap **Channels are set ✓** and it folds into a one-line summary; every new set starts with this step open again. The song mix and meters use these channels. After about 10 seconds of a song, **Use what I'm hearing** suggests the lead and harmonies from which mics are active and how strongly. Everything saves at once, the song's mix applies straight away so you hear it, and it's remembered for next time.
- **Follow ProPresenter** (ProPresenter 7.9 or later): turn on **Settings → Network → Enable Network** on the ProPresenter computer, then enter the IP address and port it shows under Set tab → ProPresenter (once). When the operator puts up a song, Mix Assistant moves to that song by itself and its song mix comes in. Names are matched loosely ("Holy Forever (Live) - Chris Tomlin" finds "Holy Forever"); announcements and sermon slides change nothing; you can still tap songs yourself, and a Wi-Fi blip never undoes your choice. Read-only: it never controls ProPresenter. Both computers must be on the same network; some guest Wi-Fi networks block computers from reaching each other.
- **Song buttons:** the engineer taps each song as it starts (or **Next song**). During worship, the lead singer and lead instrument stand out: harmonies sit 4 dB back, singers not on that song 10 dB, other instruments 3 dB (all adjustable under **Song mix amounts**, or switched off). Tapping a song also tells the auto-mix worship has started. House faders only; in-ears and click never touched; any fader you move wins; **No song** puts everyone back.

### PA setup (gain staging the PRX ONE and Passport)

The **PA setup** tab walks through it in six steps, on any device:
1. **Prepare the speakers:** a short checklist (other PRX ONE inputs down, Bluetooth off, effects off, pass-thru at 0 dB with a ~100 Hz high-pass, Passport EQ flat, everything starting low).
2. **Set each channel's gain:** someone talks or sings into each mic, and the app reads that channel live and says **Good**, or "raise the gain about 6 dB" (target: peaks around -18 to -12).
3. **Set the PRX ONE:** with the XR18 main at 0 dB and **test noise** playing (a steady "shhh" from the booth Mac through the music channel, about -20 dBFS, stops by itself after 90 seconds), set the PRX ONE input gain, then its master with a phone sound meter (75–80 dBA speaking, 85–90 dBA loudest worship).
4. **Set the Passport fill** by walking the room with the test noise playing.
5. **Check for hiss:** with everyone quiet, it lists open channels with hiss, separately from anything still playing.
6. **Write down the knob positions:** saved with the venue, so bumped knobs can be put back next week.

[docs/PA-GAIN-STAGING.md](docs/PA-GAIN-STAGING.md) has the reasoning behind each step.

### Venues, Wi-Fi or cable, and the setup checklist

- **Reach the mixer over** (This Mac card): **Automatic** (recommended: uses a cable if one reaches the mixer, otherwise Wi-Fi), **Prefer Wi-Fi**, or **Prefer cable**. A preference never drops a working connection: if the preferred path can't reach the mixer, it stays on the other one and says so. The line underneath, and the Mixer pill at the top on every device, show which one is in use. A cable needs a USB-C to Ethernet adapter on this laptop.
- **Mixer model** (This Mac card, Tech mode): **Behringer XR18** (the default, and the mixer in use) or **Behringer X32 / X32 Rack**, for if you upgrade. Choosing one asks you to confirm, then Mix Assistant restarts (about 10 seconds) and looks for that mixer; people, songs and saved tones are kept. Only the booth Mac can change it. The X32 setting has **not been run on a real X32 yet**: before a service on one, work through the check list under "If we upgrade to an X32 Rack" in [docs/ROADMAP.md](docs/ROADMAP.md). On the X32, buses 1–12 are treated as in-ear mixes and never changed, FX1–4 are assumed to be fed from buses 13–16, computer playback is assumed on aux in 7/8, and the feedback catcher is off for now. `"mixerModel": "x32"` (or `"xr18"`) in `config.json` fixes the model and overrides the setting.
- **Venues** (This Mac card): save each place you set up with its connection choice and notes ("Power strip behind stage left"). Choosing a venue applies its connection and shows its notes at the top of the setup checklist.
- **Setup checklist** (Pre-service check, on every device): the app ticks what it can check itself (mixer connected, click and guide locked, an iPad connected, music player ready). Volunteers tick the rest from any iPad: speakers at their marks, PRX ONE Bluetooth off, wireless scanned with fresh batteries, in-ears working, Do Not Disturb, playlist downloaded. Ticks start fresh each day.

The download page can also be published as a website: in the repository's **Settings → Pages**, choose **Deploy from a branch**, branch **stable**, folder **/docs**. It then appears at https://mchljns.github.io/AI-Audio-Engineer-/.

For developers, the same installer runs from Terminal: `curl -fsSL https://raw.githubusercontent.com/mchljns/AI-Audio-Engineer-/stable/install.sh | bash` (add `MIX_CHANNEL=main` before `bash` for untested work). After changing `install.sh` or `macos/installer-launch.sh`, run `scripts/build-mac-installer.sh` (a test checks the download is in sync).

### Using it

1. **Put the Mac and the iPad on the XR18's own Wi-Fi.** See [docs/NETWORK.md](docs/NETWORK.md) for the one-time setup (fixed Mac address, auto-join) and for keeping Spotify working with downloaded playlists.
2. **Double-click the Mix Assistant app** (Desktop) to open it. It's already running in the background and finds the mixer on its own.
3. **Connect each iPad once, with nothing to type:** put it on the same Wi-Fi, click **📱 Connect an iPad** on the Mac, point the iPad's Camera at the QR code and tap the link (it opens signed in), then **Share → Add to Home Screen**. From then on, just tap that icon. Set the iPad's **Auto-Lock to Never** for services.

If it can't find the mixer:
- If the app shows that macOS is blocking network access, open **System Settings → Privacy & Security → Local Network** and turn on **node**.
- Otherwise create `~/MixAssistant/data/config.json` containing `{ "mixerHost": "192.168.1.50" }` with your XR18's address (shown in the X Air app's connection screen).

While it runs, it keeps the Mac from going to sleep on its own. Closing a laptop's lid still puts it to sleep. If the Mac restarts, Mix Assistant starts again once someone logs in, so consider turning on automatic login for the booth Mac.

For troubleshooting, use **Save a report** in the app's This Mac card and send the file. (Logs are also in `~/MixAssistant/logs/bridge.log`.) To remove Mix Assistant completely: run `launchctl bootout gui/$(id -u)/com.mixassistant.bridge` in Terminal, then delete `~/Library/LaunchAgents/com.mixassistant.bridge.plist`, the `~/MixAssistant` folder, `~/Applications/Mix Assistant.app` and the Desktop shortcut.

### Mac settings for services

- **System Settings → Sound → Alert sounds:** play through the Mac's built-in speakers, not the XR18. Otherwise notification dings go through the PA.
- Turn on **Do Not Disturb** during services.
- In **Audio MIDI Setup**, make sure the Mac's default output (Music/Spotify) goes to the XR18 USB channels that feed your pre/post-service music channel, not a track, click or guide channel.

### Name your channels

The app reads names from the mixer, so consistent names make it work best. Suggested layout:

| Ch | Name | | Ch | Name |
|---|---|---|---|---|
| 1 | Pastor | | 9–11 | Trk 1, Trk 2, Trk 3 |
| 2 | Announce | | 12–14 | (spare) |
| 3–5 | Vox 1, Vox 2, Vox 3 | | 15 | **Click** |
| 6 | Ac Gtr (NUX) | | 16 | **Guide** |
| 7–8 | Keys L, Keys R | | Aux 17/18 | Spotify |

## First test on the real mixer (midweek, not Sunday)

Keep the X Air app open as a backup.

1. Open the Mix Assistant app from the Desktop. Check the mixer shows as connected.
2. Compare the inventory against reality. Are names and roles right? Does "In use" match what's plugged in and making sound?
3. In the X Air app, turn **on** the main L/R assign for the click channel. The web app should turn it back off within a second or two and show an alert.
4. In the X Air app, raise the click's send to FX1. Same result expected.
5. Check that every in-ear aux send is **pre-fader** in the X Air app. Then move a singer's channel fader: their in-ear mix must not change. (The auto-mix relies on this to leave the in-ears alone.)
6. Connect an iPad with the QR code, add it to the Home Screen, close Safari, open the icon (it should not ask for a PIN), and move a fader. Check the X Air app shows the same move.
7. Save a pre-service playlist and try **Fade music in** and **Fade music out** from an iPad. The first time, allow "node" to control Spotify when macOS asks.
   Then, on the Auto screen, have someone talk on the pastor's mic, then the announcement mic: the other one should come down. Move a channel fader up and down: does its meter move with it? If it does, tell me (the meters are post-fader, and one setting needs changing).
8. Note anything that looks wrong, then tap **Save a report for troubleshooting** in the This Mac card and send the file along with any screenshots.

When this passes, the version you tested gets promoted to `stable`.

## Layout

```
src/
  bridge.js          booth bridge: mixer link + web server
  dev.js             bridge + simulator for development
  osc.js             OSC message encoding
  xair/              XR18 addresses, fader law, network client
  mixerState.js      live copy of the mixer
  roles.js           channel-name recognition
  inventory.js       inventory + remembered role confirmations
  clickGuard.js      click & guide lock
  fades.js           smooth fades
  simulator/         simulated XR18
public/              the web app
test/                tests (including end-to-end against the simulator)
```

Setup guides: [docs/NETWORK.md](docs/NETWORK.md) (no new hardware, Spotify keeps working) and [docs/PA-GAIN-STAGING.md](docs/PA-GAIN-STAGING.md) (your XR18 → PRX ONE → Passport chain, vocal chain, wireless and in-ears).

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next and [docs/QA.md](docs/QA.md) for every failure mode reviewed and how it's handled.
