# Roadmap

Priorities: **ease of use** and **auto-mixing**, no new hardware, Spotify stays on Wi-Fi.

Built for this system: XR18 → PRX ONE (both mains, summed) → pass-thru → Passport fill; 4 Phenyx Pro PTU-7000 mics + Shure BLX14R earset; NUX acoustic, stereo keys, tracks, click and guide on their own channels; 4 in-ear mixes on aux 1–4 through two PTM-10s; pre- and post-service music from Spotify on the booth Mac.

## Done

- **0.1–0.2 Foundation and hardening:** mixer link, channel inventory, click & guide lock (main L/R, FX, protected buses, sticky), mute unused, music fades, console view, PIN, background service, stable channel.
- **0.3 Auto-mix:** speech gain sharing, automatic service modes, music ducked under talking, singer mics muted during the sermon, Auto screen. Fixes from an independent review.
- **0.4 Pre/post-service music player:** Spotify (or Apple Music) on the Mac controlled from the iPad: Fade music in (play + fade up), Fade music out (fade out + pause), transport, saved playlists, offline warning. Network guide for iPads on the mixer's Wi-Fi. (0.4.1: "walk-in" renamed to pre/post-service music.)
- **0.5 No Terminal:** download page and Mix Assistant Installer app; a Mix Assistant app on the Desktop; in-app updates, practice mode and troubleshooting report on the booth Mac's This Mac card.
- **0.5.1 QR connect:** scan once per iPad; the home-screen icon signs in every week.
- **0.13 Live tempo for the delay:** hears the tempo from the click (or tracks, or a steady strum), remembers it per song, and after a one-time check sets the delay time itself.
- **0.12 Effects:** speech kept dry, reverb and delay follow the service, per-person reverb and delay amounts in Tone, light delay per song with tempo from Planning Center or tap tempo, reverb help.
- **0.11 Tone at soundcheck:** per-person EQ fix buttons, compression set by listening, a hiss gate set from the mic's own noise, undo, and tone saved per person that follows them to this week's channel.
- **0.10 Vocal riding and a live status line:** keeps the lead on top as needed (Off / Gentle / Normal / Strong), with boost safeguards; plain-English "what it's doing" on the Auto screen and Set tab.
- **0.9 Follow ProPresenter and this week's channels:** the song ProPresenter puts up becomes the current song; people's channels can change per set. (0.9.1: per-week sings/plays chips and Add someone in the soundcheck view. 0.9.2: a weekly "This week's channels" step with Find by listening and last-week memory.)
- **0.8.1–0.8.2 Soundcheck view:** set roles while hearing each song: one row per person (sing and play together), Lead / Harmony / Off for their vocal, ★ Lead on their instrument, live levels, and a "what I'm hearing" suggestion.
- **0.8 Sets:** people and their instruments (mono/stereo acoustic per person), channels per stage position, Planning Center import, set wizard with per-song lead singer / harmonies / lead instrument remembered per song, and a song button that applies a house-only song mix.
- **0.7 PA setup:** guided gain staging for the PRX ONE and Passport with a live gain check, test noise from the Mac, a hiss check, and knob positions saved per venue.
- **0.6 Venues:** Wi-Fi or cable preference with live status, saved venues with notes, and a daily setup checklist.
- **0.3.x Fitted to this system:** mono-PA pan check, PRX ONE / Passport / vocal / wireless / in-ear setup guide. Singer mics are no longer muted while someone talks on them (worship leader praying after the sermon); pre/post-service music ducks under a welcome.

## Next, in order

### 1. Midweek test on the real XR18 (blocking everything else)
Confirms the mixer commands and meter behaviour the auto-mix depends on (QA P1–P6, M7, M9). Nothing below is worth building on unconfirmed foundations.

### 2. Noise and wireless health on the pre-service check (your noise-floor problem)
The auto-mix already measures each channel's noise floor. Show it per channel as "hiss level", warn when a mic's hiss is high, and say what to check: receiver output too low and XR18 gain too high, makeup gain, a weak battery, or interference. Also warn if a wireless channel goes silent mid-service (battery or dropout).

### 3. People profiles (ease of use, auto-mix quality)
Four PTU-7000 packs, rotating singers. Pick "who's on which pack" before the service, and each person's gain trim, EQ, gate and compressor come back automatically. In-ear mixes are not touched. The auto-mix also learns each person's normal level.

### 4. ~~Vocal riding during worship~~ (built in 0.10; notes kept for the remaining override idea)
Keep whoever is carrying the song on top of keys, acoustic and tracks. **There is no fixed lead singer**: the lead changes from song to song and sometimes within a song (singers trading verses, call and response). So:

- **Every singer mic is treated the same.** No channel is ever labelled "the lead".
- **Each singer is compared with their own normal level**, learned over the service (and later from their profile), so a naturally quiet singer isn't overlooked and a loud one isn't over-favoured.
- **Whoever is singing strongest against their own normal is "on top" right now.** The other singers sit back by a few dB. A swap is followed within about half a second, with a short hold so quick back-and-forth lines don't make the levels flicker.
- **When everyone sings together** (a chorus), nobody is favoured.
- **If the vocals are getting buried,** the lead comes up (within the strength limit, only while singing) and then the band and tracks come down.
- **Optional override:** tap a singer's name on the Auto screen to keep them on top for this song; tap again for automatic.
- Bounded moves (Gentle ±2, Normal ±4, Strong ±6 dB), any fader move wins, faders only (in-ears untouched).

### 5. Feedback watch for the pastor's omni earset
Needs a small native macOS helper to read the XR18's USB audio, plus microphone permission. Detects a ringing frequency and pulls the pastor's channel down briefly, then suggests a notch EQ. The biggest remaining technical step.

### 6. Plain-English assistant
"The pastor sounds muffled", "the keys are too loud in the room" → a proposed change with undo. Useful once profiles exist; lowest priority.

## Dropped or deferred

- **Anything that changes the in-ear mixes (aux sends):** out of scope. The band mixes their own ears.
- **Ducking done by the mixer's own duck gates:** deferred. The app-held ducking is bounded (8 dB), saved, and restored on restart (QA M3), which is enough for now.
- **Setting the reverb's and delay's own parameters (decay, delay time) from the app:** after the FX parameter commands are confirmed on the XR18. Until then the app shows the exact settings to use in X Air, including each song's delay time.
- **Helix integration:** not part of this setup.
- **Native iPad app:** not needed; the web app plus the background service on the Mac covers it.
