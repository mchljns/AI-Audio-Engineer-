# Church Mix Assistant

An assistant for a Behringer XR18 at a small church. A small **bridge** program runs on the booth Mac (the one that already runs Prime and walk-in music). It talks to the mixer over the network, and volunteers use the **web app** from any iPad, phone or computer on the same network.

It works alongside the Behringer X Air app, which stays available as a backup.

## The auto-mix

The app opens on the **Auto** screen. It listens to the channel meters and mixes the service by itself:

- **Balances the speech mics.** Whoever is talking (pastor, announcements) stays up; the other speech mic comes down, so there's less hiss and less feedback. Between sentences the last talker stays up.
- **Knows where the service is.** Walk-in → Worship → Talking over music → Speaking, worked out from which channels are making sound. Big buttons let a volunteer set the mode instead.
- **Turns the band and tracks down under talking** during announcements and prayer over music, and brings them back smoothly.
- **Mutes singer mics during the sermon** (after 20 seconds of speaking), and unmutes them the moment music starts.
- It only ever turns things **down** from where a person set them, never up. Moving any fader (here or in the X Air app) sets that channel's new level. Each feature has its own off switch. If the app restarts, it puts everything back first.

A **Mixer** tab has the full console view for anything else.

## What else it does

- **Connects to the XR18** automatically and keeps a live copy of every channel's name, mute, fader, main assign, FX sends and level.
- **Channel inventory.** Reads the channel names and works out what each channel is (pastor, singer, keys, track, click…). Combined with live signal, it shows what's in use, what's named but silent (dead battery?), and what has signal but no name.
- **Click & guide lock.** Channels named Click/Guide (or confirmed as such) are kept out of the house:
  - Main L/R assign is forced off.
  - Sends to FX1–4 are forced to zero, because effects returns feed the house.
  - Sends to monitor buses that people outside the band hear are forced to zero. These are worked out from the bus names (Stream, Live, Rec, Lobby, Wedge, Pastor…) or listed in `config.json` as `"protectedBuses": [5, 6]`. The band's in-ear buses are left alone.
  - It watches for changes from any app or scene recall and undoes them within moments, with an alert.
  - **The lock is sticky.** If someone renames the Click channel, it stays protected and the volunteer is warned, until a person sets what the channel is now.
- **Mute unused channels** with one tap. Only touches channels with no name and no signal, never click/guide. This helps the noise floor.
- **Walk-in music.** Fade out smoothly when the service starts, and bring it back to its saved level afterwards. If someone grabs the fader during a fade, the fade stops and the person wins.
- **PIN for other devices.** iPads and phones enter a 4-digit PIN once (shown at the top of the app on the booth Mac). Five wrong tries locks that device out for a minute. The booth Mac itself never needs it.
- **Console-style mixer view**: side-by-side channel strips with fader, meter, mute, main (LR) assign and a colour-coded name strip, plus the 4 DCA groups at the right. Faders move relative to your finger, so touching one never makes it jump. Tap a name strip to see what the app thinks the channel is, or to change it. The pre-service check and alerts fold away above the strips.
- **Confirm a channel's role** when the name is unclear (e.g. "Sarah"). The answer is remembered, but only while the channel keeps that name. Rename it, and the app reads the new name again.

## Try it without the mixer

You need [Node.js](https://nodejs.org) 20 or newer (runs natively on Apple silicon Macs).

```bash
npm install
npm run dev
```

Open http://localhost:8081. This runs a simulated XR18 with the church layout, playing a pretend service on a loop (walk-in, worship, announcements, sermon) so you can watch the auto-mix work. To watch the click lock work, run `npm run dev -- --chaos`: every 20 seconds the simulator pretends someone routed the click or guide into the house.

```bash
npm test
```

## Install on the booth Mac

Open **Terminal** (press ⌘-Space, type *Terminal*, press Return), paste this line and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/mchljns/AI-Audio-Engineer-/stable/install.sh | bash
```

It takes a minute or two and needs no administrator password. It:
- puts everything in a **MixAssistant** folder in your home folder, including its own copy of Node.js, so nothing else on the Mac is touched
- runs Mix Assistant **in the background**, starting by itself whenever someone logs in to the Mac, and restarting itself if it ever crashes (macOS may show a "Background Items Added" notice)
- adds two shortcuts to your **Desktop**:
  - **Mix Assistant** opens the app (use with the real XR18)
  - **Mix Assistant (practice)** a pretend mixer for learning, on its own port so it never interferes
- opens the app and practice mode so you can look around

To **update** later, run the same line again. Your settings are kept. It installs the **stable** version: the last one tested on the real mixer. To try the newest work midweek, put `MIX_CHANNEL=main` before `bash` at the end of the line.

### Using it

1. **Put the Mac and the XR18 on the same network** without losing the Mac's internet for Spotify. See [docs/NETWORK.md](docs/NETWORK.md): either the XR18 joins the church Wi-Fi, or one Ethernet cable from the Mac to the XR18. Use the staff network, not guest Wi-Fi: the XR18 itself has no password.
2. **Double-click "Mix Assistant" on the Desktop** to open the app. It's already running in the background and finds the mixer on its own.
3. **On the iPad:** connect to the same network and open the address shown at the top of the app on the Mac (e.g. `192.168.1.20:8080`), then enter the PIN shown next to it. Tap **Share → Add to Home Screen**. Set the iPad's **Auto-Lock to Never** for services.

If it can't find the mixer:
- If the app shows that macOS is blocking network access, open **System Settings → Privacy & Security → Local Network** and turn on **node**.
- Otherwise create `~/MixAssistant/data/config.json` containing `{ "mixerHost": "192.168.1.50" }` with your XR18's address (shown in the X Air app's connection screen).

While it runs, it keeps the Mac from going to sleep on its own. Closing a laptop's lid still puts it to sleep. If the Mac restarts, Mix Assistant starts again once someone logs in, so consider turning on automatic login for the booth Mac.

Logs are in `~/MixAssistant/logs/bridge.log`. To remove Mix Assistant completely, run `launchctl bootout gui/$(id -u)/com.mixassistant.bridge`, then delete `~/Library/LaunchAgents/com.mixassistant.bridge.plist`, the `~/MixAssistant` folder and the two Desktop shortcuts.

### Mac settings for services

- **System Settings → Sound → Alert sounds:** play through the Mac's built-in speakers, not the XR18. Otherwise notification dings go through the PA.
- Turn on **Do Not Disturb** during services.
- In **Audio MIDI Setup**, make sure the Mac's default output (Music/Spotify) goes to the XR18 USB channels that feed your walk-in channel, not a track, click or guide channel.

### Name your channels

The app reads names from the mixer, so consistent names make it work best. Suggested layout:

| Ch | Name | | Ch | Name |
|---|---|---|---|---|
| 1 | Pastor | | 9–11 | Trk 1, Trk 2, Trk 3 |
| 2 | Announce | | 12–14 | (spare) |
| 3–5 | Vox 1, Vox 2, Vox 3 | | 15 | **Click** |
| 6 | Ac Gtr | | 16 | **Guide** |
| 7–8 | Keys L, Keys R | | Aux 17/18 | Walk-in |

## First test on the real mixer (midweek, not Sunday)

Keep the X Air app open as a backup.

1. Open the app from the Desktop shortcut. Check the mixer shows as connected.
2. Compare the inventory against reality. Are names and roles right? Does "In use" match what's plugged in and making sound?
3. In the X Air app, turn **on** the main L/R assign for the click channel. The web app should turn it back off within a second or two and show an alert.
4. In the X Air app, raise the click's send to FX1. Same result expected.
5. If you have a livestream bus, name it "Stream" in the X Air app and send the click to it. It should be pulled back to zero. The click's in-ear sends should stay as they are.
6. On an iPad, open the app, enter the PIN, and move a fader. Check the X Air app shows the same move.
7. Try **Fade out** and **Bring up** on the walk-in music.
   Then, on the Auto screen, have someone talk on the pastor's mic, then the announcement mic: the other one should come down. Move a channel fader up and down: does its meter move with it? If it does, tell me (the meters are post-fader, and one setting needs changing).
8. Note anything that looks wrong and send screenshots plus `~/MixAssistant/logs/bridge.log`.

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

Setup guides: [docs/NETWORK.md](docs/NETWORK.md) (no new hardware, Spotify keeps working) and [docs/PA-GAIN-STAGING.md](docs/PA-GAIN-STAGING.md) (XR18 into the PRX ONE and Passport).

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next and [docs/QA.md](docs/QA.md) for every failure mode reviewed and how it's handled.
