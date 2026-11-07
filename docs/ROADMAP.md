# Roadmap

Priorities: **ease of use** and **auto-mixing**, no new hardware, Spotify stays on Wi-Fi.

Built for this system: XR18 → PRX ONE (both mains, summed) → pass-thru → Passport fill; 4 Phenyx Pro PTU-7000 mics + Shure BLX14R earset; NUX acoustic, stereo keys, tracks, click and guide on their own channels; 4 in-ear mixes on aux 1–4 through two PTM-10s; walk-in music from Spotify on the booth Mac.

## Done

- **0.1–0.2 Foundation and hardening:** mixer link, channel inventory, click & guide lock (main L/R, FX, protected buses, sticky), mute unused, walk-in fades, console view, PIN, background service, stable channel.
- **0.3 Auto-mix:** speech gain sharing, automatic service modes, music ducked under talking, singer mics muted during the sermon, Auto screen. Fixes from an independent review.
- **0.3.x Fitted to this system:** mono-PA pan check, PRX ONE / Passport / vocal / wireless / in-ear setup guide. Singer mics are no longer muted while someone talks on them (worship leader praying after the sermon); walk-in music ducks under a welcome.

## Next, in order

### 1. Midweek test on the real XR18 (blocking everything else)
Confirms the mixer commands and meter behaviour the auto-mix depends on (QA P1–P6, M7, M9). Nothing below is worth building on unconfirmed foundations.

### 2. Spotify / Music control from the iPad (ease of use)
Play, pause, next track and playlist for walk-in music, next to the Fade buttons, so nobody touches the Mac on Sunday. Controls the Spotify or Music app on the Mac directly; no new hardware. "Start walk-in" becomes one tap: play the playlist and fade up.

### 3. Noise and wireless health on the pre-service check (your noise-floor problem)
The auto-mix already measures each channel's noise floor. Show it per channel as "hiss level", warn when a mic's hiss is high, and say what to check: receiver output too low and XR18 gain too high, makeup gain, a weak battery, or interference. Also warn if a wireless channel goes silent mid-service (battery or dropout).

### 4. People profiles (ease of use, auto-mix quality)
Four PTU-7000 packs, rotating singers. Pick "who's on which pack" before the service, and each person's gain trim, EQ, gate, compressor and **their in-ear mix (aux 1–4 sends)** come back automatically. The auto-mix also learns each person's normal level.

### 5. Vocal riding during worship (auto-mix)
Keep the lead vocal on top of keys, acoustic and tracks during songs, with small, bounded moves (up to about 4 dB), following the same rules as the rest of the auto-mix: never above the level a person set, and any fader move wins.

### 6. Feedback watch for the pastor's omni earset
Needs a small native macOS helper to read the XR18's USB audio, plus microphone permission. Detects a ringing frequency and pulls the pastor's channel down briefly, then suggests a notch EQ. The biggest remaining technical step.

### 7. Plain-English assistant
"The pastor sounds muffled", "Sarah can't hear herself" → a proposed change with undo. Useful once profiles exist; lowest priority.

## Dropped or deferred

- **Ducking done by the mixer's own duck gates:** deferred. The app-held ducking is bounded (8 dB), saved, and restored on restart (QA M3), which is enough for now.
- **Tempo-synced delay, effects automation:** deferred; not a priority for this team.
- **Helix integration:** not part of this setup.
- **Native iPad app:** not needed; the web app plus the background service on the Mac covers it.
