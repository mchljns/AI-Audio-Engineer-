# Church Mix Assistant

An assistant for a Behringer XR18 at a small church. A small **bridge** program runs on the booth Mac (the one that already plays the pre- and post-service music). It talks to the mixer over the network, and volunteers use the **web app** from any iPad, phone or computer on the same network.

It works alongside the Behringer X Air app, which stays available as a backup.

## The auto-mix

The app opens on the **Auto** screen. It listens to the channel meters and mixes the service by itself:

- **Balances the speech mics.** Whoever is talking (pastor, announcements) stays up; the other speech mic comes down, so there's less hiss and less feedback. Between sentences the last talker stays up.
- **Knows where the service is.** Before / after (pre- and post-service music) → Worship → Talking over music → Speaking, worked out from which channels are making sound. Big buttons let a volunteer set the mode instead.
- **Turns the band and tracks down under talking** during announcements and prayer over music, and brings them back smoothly.
- **Turns unused singer mics down in the room during the sermon** (after 20 seconds of speaking), and brings them back the moment music starts or someone talks into one.
- **It never touches the in-ear mixes.** It only moves channel faders and never mutes, so with pre-fader aux sends (the XR18 setting for in-ears) the band's mixes don't change.
- It only ever turns things **down** from where a person set them, never up. Moving any fader (here or in the X Air app) sets that channel's new level. Each feature has its own off switch. If the app restarts, it puts everything back first.

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
