# Church Mix Assistant

An assistant for a Behringer XR18 at a small church. A small **bridge** program runs on the booth Mac (the one that already runs Prime and walk-in music). It talks to the mixer over the network, and volunteers use the **web app** from any iPad, phone or computer on the same network.

It works alongside the Behringer X Air app, which stays available as a backup.

## What step 1 does

- **Connects to the XR18** automatically and keeps a live copy of every channel's name, mute, fader, main assign, FX sends and level.
- **Channel inventory.** Reads the channel names and works out what each channel is (pastor, singer, keys, track, click…). Combined with live signal, it shows what's in use, what's named but silent (dead battery?), and what has signal but no name.
- **Click & guide lock.** Channels named Click/Guide (or confirmed as such) are kept out of the house:
  - Main L/R assign is forced off.
  - Sends to FX1–4 are forced to zero, because effects returns feed the house.
  - It watches for changes from any app or scene recall and undoes them within moments, with an alert.
  - Monitor sends (aux 1–6) are left alone; that's where click and guide belong.
- **Mute unused channels** with one tap. Only touches channels with no name and no signal, never click/guide. This helps the noise floor.
- **Walk-in music.** Fade out smoothly when the service starts, and bring it back to its saved level afterwards. If someone grabs the fader during a fade, the fade stops and the person wins.
- **Console-style mixer view**: side-by-side channel strips with fader, meter, mute, main (LR) assign and a colour-coded name strip, plus the 4 DCA groups at the right. Faders move relative to your finger, so touching one never makes it jump. Tap a name strip to see what the app thinks the channel is, or to change it. The pre-service check and alerts fold away above the strips.
- **Confirm a channel's role** when the name is unclear (e.g. "Sarah"). The answer is remembered, but only while the channel keeps that name. Rename it, and the app reads the new name again.

## Try it without the mixer

You need [Node.js](https://nodejs.org) 20 or newer (runs natively on Apple silicon Macs).

```bash
npm install
npm run dev
```

Open http://localhost:8080. This runs a simulated XR18 with the church layout. To watch the click lock work, run `npm run dev -- --chaos`: every 20 seconds the simulator pretends someone routed the click or guide into the house.

```bash
npm test
```

## Install on the booth Mac

Open **Terminal** (press ⌘-Space, type *Terminal*, press Return), paste this line and press Return:

```bash
curl -fsSL https://raw.githubusercontent.com/mchljns/AI-Audio-Engineer-/main/install.sh | bash
```

It takes a minute or two and needs no administrator password. It:
- puts everything in a **MixAssistant** folder in your home folder, including its own copy of Node.js, so nothing else on the Mac is touched
- adds two shortcuts to your **Desktop**:
  - **Mix Assistant** — use with the real XR18
  - **Mix Assistant (practice)** — try it with a pretend mixer
- opens practice mode so you can look around

To **update** later, run the same line again. Your settings are kept.

### Using it

1. **Connect the Mac to the XR18.** Best: an Ethernet cable from the Mac to the XR18's Ethernet port (or both into the same router), and keep the Mac's Wi-Fi on the church internet. Or join the XR18's own Wi-Fi.
2. **Double-click "Mix Assistant" on the Desktop.** A Terminal window opens (leave it open; closing it stops the app) and the app opens in the browser. It finds the mixer on its own.
3. **On the iPad:** connect to the same network and open the address shown in the Terminal window, e.g. `http://192.168.1.20:8080`. Then **Share → Add to Home Screen**. Set the iPad's **Auto-Lock to Never** for services.

If it can't find the mixer, create `~/MixAssistant/data/config.json` containing `{ "mixerHost": "192.168.1.50" }` with your XR18's address (shown in the X Air app's connection screen).

While it runs, it keeps the Mac awake.

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

1. Start the bridge and open the web app. Check the mixer shows as connected.
2. Compare the inventory against reality. Are names and roles right? Does "In use" match what's plugged in and making sound?
3. In the X Air app, turn **on** the main L/R assign for the click channel. The web app should turn it back off within a second or two and show an alert.
4. In the X Air app, raise the click's send to FX1. Same result expected.
5. Try **Fade out** and **Bring up** on the walk-in music.
6. Note anything that looks wrong and send screenshots plus the Terminal output.

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

See [docs/ROADMAP.md](docs/ROADMAP.md) for what's next.
