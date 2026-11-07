# Roadmap

## Step 1: Foundation ✅
Mixer connection, channel inventory, click & guide lock, mute unused, walk-in fades, console-style mixer view.

## Step 1.5: Hardening ✅ (0.2.0)
Sticky click/guide lock and protected monitor buses, PIN for other devices, mixer search on every network, background service, stable release channel, network-blocked detection. See QA.md.

**Still to verify on real hardware:** meter data layout (`/meters/1`), the address used for channel FX sends (`/ch/NN/mix/07..10/level`), and whether the XR18 echoes our own changes back. The simulator follows the community-documented X Air protocol; the first midweek test confirms it.

## Step 2: Service modes
- Modes: Walk-in, Worship, Speech over music (announcements/prayer), Sermon
- Automatic mode detection from which mics are active, with a big manual override
- Speech automix for pastor + announcements mics
- Ducking under speech done **by the mixer** (the XR18's built-in duck mode on band/track channels, keyed from the speech mics). The app sets it up and tunes it; it never holds the ducked state itself, so nothing is left stuck if the app stops (QA rule S7)
- Optional EQ carve around 1–4 kHz while speech is active
- Speech mics added to the band's monitors during speech-over-music
- Set up DCA and mute group assignments from the inventory

## Step 3: Profiles
- Person, instrument, mic/system and song profiles (gain, HPF, EQ, gate, compressor, fader, monitor sends, notes)
- Weekly lineup: who's on which mic
- Safe loading before the service (muted while gain changes)

## Step 4: Soundcheck assistant
- Measure each channel's noise floor and set gate/expander thresholds
- Gain staging checks ("raise the transmitter, not the preamp")
- Feedback ring-out and live feedback guard (needs USB audio analysis on the Mac)
- Click detection by sound, as a second safety layer

## Step 5: Effects
- Vocal plate, tempo delay, instrument room; graphic EQ on mains
- Tempo from the click / song profile
- Mode-aware sends that let tails ring out

## Step 6: Plain-English assistant
- "Pastor sounds muffled" → proposed, bounded changes with undo
- Learning from volunteer corrections
