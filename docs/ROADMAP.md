# Roadmap

Priorities: **ease of use** and **auto-mixing**, no new hardware, Spotify stays on Wi-Fi.

Built for this system: XR18 → PRX ONE (both mains, summed) → pass-thru → Passport fill; 4 Phenyx Pro PTU-7000 mics + Shure BLX14R earset; NUX acoustic, stereo keys, tracks, click and guide on their own channels; 4 in-ear mixes on aux 1–4 through two PTM-10s; pre- and post-service music from Spotify on the booth Mac.

## Done

- **0.1–0.2 Foundation and hardening:** mixer link, channel inventory, click & guide lock (main L/R, FX, protected buses, sticky), mute unused, music fades, console view, PIN, background service, stable channel.
- **0.3 Auto-mix:** speech gain sharing, automatic service modes, music ducked under talking, singer mics muted during the sermon, Auto screen. Fixes from an independent review.
- **0.4 Pre/post-service music player:** Spotify (or Apple Music) on the Mac controlled from the iPad: Fade music in (play + fade up), Fade music out (fade out + pause), transport, saved playlists, offline warning. Network guide for iPads on the mixer's Wi-Fi. (0.4.1: "walk-in" renamed to pre/post-service music.)
- **0.5 No Terminal:** download page and Mix Assistant Installer app; a Mix Assistant app on the Desktop; in-app updates, practice mode and troubleshooting report on the booth Mac's This Mac card.
- **0.5.1 QR connect:** scan once per iPad; the home-screen icon signs in every week.
- **0.18 Console look:** hardware-console visual design (hairline panels, lit keys, LED meters, role colour blocks, bundled Barlow type, line icons instead of emoji).
- **0.17 First-time welcome on each device:** booth Mac setup wizard and iPad quick start; ⚙︎ settings menu.
- **0.16 Volunteer-ready:** Get ready guided morning, Volunteer and Tech modes, status light, Hands off, plain-word results, Before / After in Tone, larger text and buttons.
- **0.15 From the research review:** harmony size compensation, delay note by tempo, reverb timed to the song, talking singers dry, hiss expander, pop guard, a write guard for the in-ears, song sections from ProPresenter, bass weeks, and a feedback catcher using the mixer's analyzer.
- **0.14 The app sets it:** input gain by listening, channel names from the lineup, one-tap reverb and delay setup (confirmed once in X Air), then direct reverb fixes and delay time.
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

## If we upgrade to an X32 Rack (planned, not started)

Most of Mix Assistant carries over: the X32 speaks a close relative of the XR18's OSC, with the same EQ types, compressor and gate modes, and nearly all mixer-specific details live in `src/xair/addresses.js`. Items marked *check* must be confirmed on a real X32 before they're trusted.

**Carries over unchanged:** sets and songs, people and roles, Get ready, Hands off, vocal riding and singer pulls, harmony compensation, ProPresenter sections, soundcheck tone buttons saved per person, feedback catcher, tempo, timed reverb, automatic delay, and the protections (in-ears never touched, no pastor reverb, click lock).

**What the Rack changes:**
- **No motor faders and no Wi-Fi.** Takeover is the same as today: tap Hands off, mix in X32-Mix (iPad) or X32-Edit (Mac).
- **Needs a Wi-Fi router in the rack** (new hardware). The mixer, Mac and iPads join the router's own password-protected network; a router that can take internet from the school Wi-Fi gives every device internet on one private network.
- **16 preamps on the Rack itself, 32 channels with a stage box** (S16/S32 over AES50). Soundcheck gain must follow the input routing to find the right preamp (*check* the X32 headamp addressing for local vs AES50 inputs).

**New features the X32 makes possible:**
1. **More channels:** 32 instead of 16 for singers and stereo instruments.
2. **Group riding with 8 DCAs:** e.g. ride "all vocals" or "band" as a group.
3. **The X32's built-in automixer for speaking** (panels, announcements, prayer), with Mix Assistant keeping its own riding for worship (*check*: limited to channels 1–8 or 25–32).
4. **8 effects instead of 4:** a dedicated vocal plate, a separate tempo delay, and a de-esser on lead vocals. Still no pastor reverb.
5. **A livestream or lobby mix on a matrix output:** a new kind of mixing, so ask before building it. In-ears stay off-limits.

**Engineering steps:**
1. ~~Mixer profiles and a **Mixer model** setting~~ (built in 0.19; XR18 stays the default). `src/xair/profiles.js` holds the XR18 and X32 profiles: port 10023, 32 channels, 8 DCAs, 16 buses (1–12 in-ear, 13–16 feeding FX1–4), aux in 7/8 for playback, `mix/st` for the main assign, two-digit bus numbers, `/fxrtn/` returns, three-digit `/headamp/` indexes. The app still uses FX1–4 and 4 of the 8 DCAs on the X32 for now.
2. ~~Profile-aware write guard~~ (0.19): blocks all buses, in-ear sends (1–12) from every source, matrices, scenes, setup and phantom.
3. ~~Simulator follows the chosen model~~ (0.19), with tests for both models.
4. **Hardware check on a real X32 before the first Sunday** (each item marked CHECK in `src/xair/profiles.js`):
   - Connects on port 10023 and reads channel names; fader moves land on the right channel.
   - Meters: `/meters/1` channel order, and aux in 7/8 at positions 39–40.
   - Main assign (`mix/st`), bus names (`/bus/01`…), FX returns (`/fxrtn/01` for FX1).
   - FX1–4 sources set to buses 13–16 on the console, and the effect sends work.
   - Preamp gain for local inputs and any stage box follows the routing (`/headamp/000` = channel 1 is assumed).
   - Analyzer address for the feedback catcher (off on the X32 until mapped).
5. Build the new features above.

**Open questions:** stage box or analog snake? Livestream or lobby mix wanted? Use the built-in automixer for speaking?

## Dropped or deferred

- **Anything that changes the in-ear mixes (aux sends):** out of scope. The band mixes their own ears.
- **Ducking done by the mixer's own duck gates:** deferred. The app-held ducking is bounded (8 dB), saved, and restored on restart (QA M3), which is enough for now.
- **Helix integration:** not part of this setup.
- **Native iPad app:** not needed; the web app plus the background service on the Mac covers it.
