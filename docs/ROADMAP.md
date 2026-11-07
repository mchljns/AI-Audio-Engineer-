# Roadmap

Priorities: **ease of use** and **auto-mixing**, no new hardware, Spotify stays on Wi-Fi.

Built for this system: XR18 → PRX ONE (both mains, summed) → pass-thru → Passport fill; 4 Phenyx Pro PTU-7000 mics + Shure BLX14R earset; NUX acoustic, stereo keys, tracks, click and guide on their own channels; 4 in-ear mixes on aux 1–4 through two PTM-10s; pre- and post-service music from Spotify on the booth Mac.

## Done

- **0.1–0.2 Foundation and hardening:** mixer link, channel inventory, click & guide lock (main L/R, FX, protected buses, sticky), mute unused, music fades, console view, PIN, background service, stable channel.
- **0.3 Auto-mix:** speech gain sharing, automatic service modes, music ducked under talking, singer mics muted during the sermon, Auto screen. Fixes from an independent review.
- **0.4 Pre/post-service music player:** Spotify (or Apple Music) on the Mac controlled from the iPad: Fade music in (play + fade up), Fade music out (fade out + pause), transport, saved playlists, offline warning. Network guide for iPads on the mixer's Wi-Fi. (0.4.1: "walk-in" renamed to pre/post-service music.)
- **0.5 No Terminal:** download page and Mix Assistant Installer app; a Mix Assistant app on the Desktop; in-app updates, practice mode and troubleshooting report on the booth Mac's This Mac card.
- **0.5.1 QR connect:** scan once per iPad; the home-screen icon signs in every week.
- **0.6 Venues:** Wi-Fi or cable preference with live status, saved venues with notes, and a daily setup checklist.
- **0.3.x Fitted to this system:** mono-PA pan check, PRX ONE / Passport / vocal / wireless / in-ear setup guide. Singer mics are no longer muted while someone talks on them (worship leader praying after the sermon); pre/post-service music ducks under a welcome.

## Next, in order

### 1. Midweek test on the real XR18 (blocking everything else)
Confirms the mixer commands and meter behaviour the auto-mix depends on (QA P1–P6, M7, M9). Nothing below is worth building on unconfirmed foundations.

### 2. Noise and wireless health on the pre-service check (your noise-floor problem)
The auto-mix already measures each channel's noise floor. Show it per channel as "hiss level", warn when a mic's hiss is high, and say what to check: receiver output too low and XR18 gain too high, makeup gain, a weak battery, or interference. Also warn if a wireless channel goes silent mid-service (battery or dropout).

### 3. People profiles (ease of use, auto-mix quality)
Four PTU-7000 packs, rotating singers. Pick "who's on which pack" before the service, and each person's gain trim, EQ, gate and compressor come back automatically. In-ear mixes are not touched. The auto-mix also learns each person's normal level.

### 4. Vocal riding during worship (auto-mix)
Keep whoever is carrying the song on top of keys, acoustic and tracks. **There is no fixed lead singer**: the lead changes from song to song and sometimes within a song (singers trading verses, call and response). So:

- **Every singer mic is treated the same.** No channel is ever labelled "the lead".
- **Each singer is compared with their own normal level**, learned over the service (and later from their profile), so a naturally quiet singer isn't overlooked and a loud one isn't over-favoured.
- **Whoever is singing strongest against their own normal is "on top" right now.** The other singers sit back by a few dB. A swap is followed within about half a second, with a short hold so quick back-and-forth lines don't make the levels flicker.
- **When everyone sings together** (a chorus), nobody is favoured.
- **If the vocals are getting buried,** the band and tracks come down slightly. Vocals are never pushed up.
- **Optional override:** tap a singer's name on the Auto screen to keep them on top for this song; tap again for automatic.
- Same rules as the rest of the auto-mix: small bounded moves (at most about 3–4 dB), never above the level a person set, any fader move wins, faders only (in-ears untouched).

### 5. Feedback watch for the pastor's omni earset
Needs a small native macOS helper to read the XR18's USB audio, plus microphone permission. Detects a ringing frequency and pulls the pastor's channel down briefly, then suggests a notch EQ. The biggest remaining technical step.

### 6. Plain-English assistant
"The pastor sounds muffled", "the keys are too loud in the room" → a proposed change with undo. Useful once profiles exist; lowest priority.

## Dropped or deferred

- **Anything that changes the in-ear mixes (aux sends):** out of scope. The band mixes their own ears.
- **Ducking done by the mixer's own duck gates:** deferred. The app-held ducking is bounded (8 dB), saved, and restored on restart (QA M3), which is enough for now.
- **Tempo-synced delay, effects automation:** deferred; not a priority for this team.
- **Helix integration:** not part of this setup.
- **Native iPad app:** not needed; the web app plus the background service on the Mac covers it.
