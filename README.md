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

1. **Install Node.js:** download the LTS installer from https://nodejs.org and run it.
2. **Get the code:** download this repository (green **Code** button → **Download ZIP**), unzip it and move the folder somewhere like `Documents/church-mix-assistant`.
3. **Install:** open **Terminal**, then:
   ```bash
   cd ~/Documents/church-mix-assistant
   npm install
   ```
4. **Connect the Mac to the XR18.** Best: an Ethernet cable from the Mac to the XR18's Ethernet port (or both into the same router), and keep the Mac's Wi-Fi on the church internet. Or join the XR18's own Wi-Fi.
5. **Start it:**
   ```bash
   npm start
   ```
   It finds the mixer on its own and prints the web address to open, e.g. `http://192.168.1.20:8080`. If it can't find the mixer, give the address directly: `MIXER_HOST=192.168.1.50 npm start`. The XR18's IP address is shown in the X Air app's connection screen.
6. **On the iPad:** connect to the same network, open that address in Safari, then **Share → Add to Home Screen**. Set the iPad's **Auto-Lock to Never** for services.

While the bridge runs, it keeps the Mac awake. Stop it with **Ctrl+C** in Terminal.

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
