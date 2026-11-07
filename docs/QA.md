# QA record

A running list of what could go wrong, what handles it, and how it's checked. Reviewed before each release. "Test" means an automated test in `test/`; "Midweek" means it can only be confirmed on the real XR18.

**0.3.0:** an independent review of 0.2.0 found that several claims below didn't hold (marked *fixed in 0.3.0*). Each finding now has a regression test in `test/review-fixes.test.js`.

## Safety: what reaches the congregation

| # | Failure | What handles it | Check |
|---|---|---|---|
| S1 | Click or guide assigned to the main speakers (by another app, a scene recall or a mistake) | Click guard turns main L/R off within moments of the mixer reporting it, and alerts. Commands from the app are checked against the lock however the channel is written (*fixed in 0.3.0: `id: 15` as a number slipped past*) | Test, Midweek |
| S1b | A fake "mixer" message on the network makes the app think click is safe | Only packets from the mixer's own address and port are accepted (*fixed in 0.3.0*) | Test |
| S2 | Click or guide sent to an effect (reverb/delay returns feed the house) | Guard zeroes FX1–4 sends | Test, Midweek |
| S3 | Click or guide sent to a monitor bus people outside the band hear (livestream, lobby, pastor wedge) | **0.3.4: the app never changes aux sends** (they're the band's in-ear mixes). Only a bus listed in `config.json` as `protectedBuses` is protected. The name-based sorting below is no longer used. Was: | Buses are sorted by name into protected (Stream, Recording, Lobby, Wedge, Main…), monitor (IEM, Mon, Keys…) and unknown. Sends to protected buses are zeroed; sends to unknown or unnamed buses raise a warning telling the volunteer what to name the bus (zeroing them blindly could cut a musician's click mid-song). `protectedBuses` / `monitorBuses` in `config.json` add to the names. *Fixed in 0.3.0: "Recording", "Streaming", unnamed buses were missed* | Test |
| S4 | Click channel renamed, so it's no longer recognised by name | Lock is sticky: the channel stays protected and the volunteer is warned. A "release the lock" button in the channel dialog hands it back when a person says it's not the click any more. *Fixed in 0.3.0: there was no way to release it* | Test |
| S5 | Click lands on a channel that was never named Click (Prime routing changed) | **Open.** Mixer setup is the first defence (LR off and recall-safe on click/guide). Recognising the click by sound is planned with audio analysis | — |
| S6 | Mix Assistant stops (crash, Mac asleep, update) | Audio never passes through it; the mixer keeps its current settings. The background service restarts it within ~10 s | Midweek |
| S7 | App stops mid-fade | Fade stops where it is. Harmless for pre/post-service music. **Rule for future automation:** anything the app holds (ducking) must be done by the mixer itself, so nothing is left stuck if the app stops | Design rule |
| S8 | Someone moves a fader the app is fading | The fade stops; the person wins | Test |
| S9 | "Mute unused" mutes something in use | Refused until every channel name has loaded and meters have flowed 15 s; shows the exact list and asks first; never click/guide. *Fixed in 0.3.0: right after a restart everything looked unused* | Test |
| S10 | Fading the pre/post-service music back in blasts at the old level | Starts from silence and fades to the saved level | Test |

## Access

| # | Failure | What handles it | Check |
|---|---|---|---|
| A1 | Someone on the church Wi-Fi opens the app and changes the mix | 6-digit PIN for every device except the booth Mac itself; shown only on the Mac's own screen; remembered per device | Test |
| A1b | Another website open in a browser on the booth Mac connects to the app | WebSocket only accepts this app's own pages (Origin check); requests must name this computer (Host check, stops DNS rebinding). *Fixed in 0.3.0* | Test |
| A1c | Volunteers find typing the address and PIN too hard | **Connect an iPad** on the Mac shows a QR code with the address and PIN built in; scanning opens Mix Assistant signed in. The PIN stays in the saved home-screen link on purpose, because iPad home-screen apps don't share Safari's storage, so the icon signs in every week with nothing to type (tested with a fresh, empty-storage page). Trade-off: anyone holding that iPad can use Mix Assistant, the same as the X Air app on it. The QR code is drawn on the Mac itself, with no internet needed | Test (browser), Midweek |
| A2 | PIN guessed by trying many | 5 wrong tries locks that device out for a minute; 6 digits. The PIN is a deterrent: keep the mixer network off guest Wi-Fi | Test |
| A5 | Anyone on the network crashes the app (bad web request, oversized message, bad meter data, a fader set to "not a number") | All rejected or handled without crashing. *Fixed in 0.3.0: three crashes found* | Test |
| A6 | App shows a change that never reached the mixer | Controls are refused and greyed out while the mixer is offline (*fixed in 0.3.0*) | Test |
| A3 | The XR18 itself has no password; anyone on its network can use the X Air app | **Network design:** keep the mixer and booth on their own network, not the guest Wi-Fi | Setup |
| A4 | Web server serves files outside the app folder | Paths are resolved and confined to `public/`; malformed addresses return 404 | Test |

## Connection

| # | Failure | What handles it | Check |
|---|---|---|---|
| C1 | Mac on both Wi-Fi and Ethernet; mixer search only looks on one | Search probes every network the Mac is on | Test |
| C2 | Practice mode's pretend mixer gets mistaken for the real one | Practice runs on separate ports (8081, 10124); the real search never probes the Mac itself | Design |
| C3 | Two XR18s answer | Uses `mixerName` from `config.json` if set, else the first, and logs all of them | Manual |
| C4 | macOS blocks local network access (Local Network privacy) | Detected from the error and shown as an alert with the exact setting to turn on | Midweek |
| C5 | Mixer drops off the network | Shown within ~6 s, fades stop, reconnects and re-reads everything | Test (sim) |
| C5b | Mixer comes back with a new address from the router | After 20 s offline the app searches again and follows it (*fixed in 0.3.0*) | Design |
| C9 | Volunteers can't tell or choose whether the mixer is reached over Wi-Fi or a cable | "Reach the mixer over" (Automatic / Prefer Wi-Fi / Prefer cable) on the Mac, with the path shown in the Mixer pill on every device. The connection type is read from macOS's port names (no admin password). A preference never drops a working connection: if the preferred path can't reach the mixer it stays put and says so (tested). Switching only happens when someone changes the setting or the mixer is lost, never by itself mid-service | Test, Midweek |
| C10 | A setup step is forgotten at a new venue | Venues (connection + notes) on the Mac; a setup checklist on every device that ticks automatic items itself and resets each day (tested) | Test |
| G1 | Gains set by guesswork | PA setup tab reads each channel's meter live with a peak hold and says Good / raise / lower by how much (target peaks -18 to -12). Relies on the meters being the channel input before the fader (P2, midweek) | Browser, Midweek |
| G2 | Test noise left running or too loud | Plays only on the booth Mac, measured at about -20 dBFS RMS (peaks about -7 dBFS), stops by itself after 90 seconds; the step says to turn the speakers down first | Browser, Midweek |
| G3 | Music or tracks mistaken for hiss | Hiss is only reported between -62 and -40 dB; anything louder is listed as "still making sound" | Browser |
| G4 | A bumped PA knob isn't noticed next week | Knob positions saved per venue from any device | Test |
| C8 | Click warnings on startup before bus names arrive | Bus names load first; the guard doesn't judge a bus until its name is known | Manual |
| C6 | A change pushed by the mixer is missed | Everything is re-read every 30 s and the lock re-checked | Design |
| C7 | Direct Mac-to-XR18 cable gets no IP address | **Setup:** use a router, or set fixed addresses. Documented | Setup |

## Mixer protocol (confirm on the real XR18)

| # | Assumption | Status |
|---|---|---|
| P15 | Analyzer /meters/4: 100 bands assumed log-spaced 20 Hz–20 kHz, 1/256 dB like the other meters; what it measures (main mix?) depends on X Air's RTA setting | Midweek: play a 1 kHz tone, check which band peaks; ring out a mic gently with the catcher on |  Midweek |
| M24 | Feedback catcher fires on music or blames the wrong mic | Needs a lone peak 15 dB over the spectrum and 8 dB over neighbours, no harmonics above or below, growing 6 dB, in 80% of 0.6 s; sung notes with harmonics, steady pads and busy music don't trigger (tests). A mic is only blamed if its level jumped 6 dB over a few seconds ago and holds steady without syllable gaps, and clearly more than any other; otherwise all open mics come down 3 dB and nothing is cut. Cuts are capped at 3 per mic and −8 dB and lifted after 5 min | Tests (simulated ring on the pastor), Midweek |
| M25 | Sections, bass weeks, harmony compensation move things unexpectedly | All cut-only and small (band −1.5 dB in verses, reverb −2 dB in choruses, harmonies −3 dB per doubling); sections only while a set song is up and switchable; bass changes only between songs and restored exactly; status line names each | Tests |
| P14 | Compressor key filter: /ch/NN/dyn/filter/on, type (3 = HC12 assumed, X32 list), f (20 Hz–20 kHz log) | Midweek: Catch pops on a spare channel and check X Air shows the dynamics key filter on, high cut ~150 Hz |  Midweek |
| M23 | A bug writes to an in-ear mix, a snapshot or phantom | One write guard in the OSC client drops any such write and alerts; tested against every pattern | Test |
| P12 | FX algorithm numbers and parameters (X32 layout assumed: Plate = type 5 with pre-delay 1, decay 2, low cut 7, high cut 8; Stereo Delay = type 10 with mix 1, time 2, low cut 7, high cut 8, feedback 10/12) | One-tap setup reads the effect first, writes, and asks the person to confirm in X Air what it should show; "No" tries the next way, then restores the effect exactly; nothing is adjusted later unless confirmed. Midweek: run both setups on FX1/FX2 | Midweek |
| P13 | Input gain /headamp/NN/gain, −12..+60 dB linear; phantom /headamp/NN/phantom never sent | Companion module code (bitfocus) | Midweek: Set gain on a spare channel, check X Air's gain |
| M22 | Automatic gain or names cause trouble | Gain only on a person's Set gain press at soundcheck, 12 dB max per press, compressor/gate follow; names only on Channels are set, checked to read back as the same role, never click/guide, never a channel used twice; switch to turn naming off | Tests, Browser |
| P11 | Delay Time = /fx/N/par/01, scaling unknown on XR18 | One-time check in Effects: sets 500 ms (log scaling first, then linear) and asks whether X Air shows 500 ms; only a Yes turns on automatic delay time; two No's leave it manual | Midweek |
| M21 | Live tempo wrong (half/double, drifting, from talking) | Click preferred, then tracks, then band; needs 8+ beats with < 30 ms spread and few off-grid; eighth-note clicks folded by the song's known tempo; delay time only changes on a > 2% difference; learned into the song only after 8 s steady in worship | Tests (66–150 BPM within 0.5 with meter jitter and missed clicks; random strumming gives nothing; the simulator's 120 BPM click end to end) |
| P10 | FX returns and sends: /rtn/1..4/mix/fader (return level in the room) and /ch/NN/mix/07..10/level (channel → FX1–4); the returns' sends to the in-ear buses are pre- or post-fader | Midweek: confirm the return fader path moves FX1 in X Air, and check whether the singers' in-ear reverb dips when the app turns the reverb down for talking (if FX return → aux sends are post-fader it will; set them pre-fader in X Air to keep in-ear reverb steady) | Midweek |
| M20 | Effects on speech; washy talking between songs; delay used wrongly | Pastor always dry (any FX send reset to zero, one note); announcements dry by default; returns down 6 dB for talking, 15 dB for sermon/pre-service; delay only on marked songs, only the lead singer, only in worship; a person moving a return sets its new level; restart puts returns back | Tests, Browser |
| P9 | Channel processing addresses: /ch/NN/preamp/hpon, hpf (20–400 Hz log); /eq/1..4/type, f (20–20k log), g (±15 lin), q (0.3–10 log, inverted); /dyn/on, thr (−60..0), ratio (index 0–11), knee, mgain, attack, release (log), auto; /gate/on, mode (3 = gate), thr (−80..0), range (3–60) | From the xair-api library (tested on MR18). Midweek: open Tone on a spare channel, tap Muddy and Medium, and check X Air shows −2 dB at 300 Hz and a 3:1 compressor; check the meter tap point (pre/post compressor) | Midweek |
| P1 | Meter blob: int32 count then int16 values in 1/256 dB | Matches Behringer's doc and forum reports; byte order to confirm |
| P2 | `/meters/1` order: 16 channels, then aux L/R | To confirm |
| P3 | `/ch/NN/mix/lr`, `/ch/NN/mix/on`, `/ch/NN/mix/fader` | To confirm |
| P4 | Sends: `/ch/NN/mix/01..06/level` (aux), `07..10` (FX1–4) | To confirm |
| P5 | `/bus/N/config/name`, `/dca/N/...` | To confirm |
| P6 | `/xremote` pushes other apps' changes to us | To confirm (fades and guard rely on it; 30 s re-sync is the backstop) |

## Install and running

| # | Failure | What handles it | Check |
|---|---|---|---|
| I1 | An untested change reaches a Sunday | Installer installs the `stable` branch only; new work goes to `main` and is promoted after a midweek test | Process |
| I2 | Node.js download corrupted or tampered with | Checked against nodejs.org's published SHA-256 | Test |
| I3 | Update leaves a half-replaced app or a stopped service | Service is stopped before Node.js or the app is replaced, and the installer waits for macOS to let go of it before starting the new one, retrying (*fixed in 0.3.0*). A cut-off download can't run half the script | Test (Linux), Midweek (Mac) |
| I4 | Settings lost on update | Settings, roles, locks and config live in `~/MixAssistant/data`, untouched by updates | Test |
| I5 | Volunteer closes the Terminal window and the app stops | No Terminal anywhere: it runs as a background service, and the Mix Assistant app just opens the page (or starts it quietly if the service isn't running) | Test (Linux), Midweek |
| I9 | Installing needs Terminal | A downloadable Mix Assistant Installer app wraps install.sh with dialogs. First open needs System Settings → Privacy & Security → Open Anyway, because it isn't signed with a paid Apple developer certificate | Test (Linux, stubbed dialogs), Midweek |
| I10 | The download falls out of date with install.sh | A test unzips the download and compares it with install.sh and the launcher | Test |
| I11 | An in-app update breaks the app | The new version is downloaded and installed beside the running one, swapped in only when complete, then the service restarts it; a failed update leaves the old version untouched (tested). Updates only from the Mac's own screen, with a second tap to confirm | Test |
| I12 | An iPad starts practice mode, updates the app or downloads the report | Those controls and the report only work from the booth Mac's own screen | Test |
| I6 | Mac sleeps during service | Bridge holds idle sleep off while running. **Closing the lid still sleeps** a laptop without an external display | Setup |
| I7 | Mac restarts | Service starts at login. **The Mac must log in** (turn on automatic login, or someone logs in) | Setup |
| I8 | Log file grows forever | Truncated on each install; the bridge logs little (search messages throttled to every 5 min) | Design |

## Auto-mix

| # | Failure | What handles it | Check |
|---|---|---|---|
| M1 | Auto-mix adds feedback | Everything except vocal riding only turns channels down. Gain sharing keeps the total speech gain constant | Test |
| M18 | Vocal riding boosts a mic into feedback | Boost only on the lead's vocal mic, in worship, while they're singing this instant (off within ~0.3 s of stopping), capped by strength and +6 dB on the fader; a boosted mic whose level climbs steadily for a second without the dips singing has gets no boost for a minute and an alert; speech mics, pastor and music never go up | Test (simulated ringing), Midweek: try Strong with a singer near a wedge |
| M19 | Vocal riding pumps or chases | 1.5 dB dead band, normal level drifts over about a minute (a quiet verse is ridden, not learned), smooth ~0.5 s moves, short hold on lead changes, full chorus favours nobody, and a status line says exactly what it's doing | Test, Midweek: listen for pumping between phrases on Normal |
| M2 | Auto-mix fights a volunteer | Any fader move (this app, X Air app) becomes that channel's new level; unmuting a singer it muted hands that singer back until the mode changes; each feature has an off switch that hands channels straight back | Test |
| M3 | App stops with the band ducked or singers muted | State saved every second; on restart it puts faders back and unmutes singers before carrying on (only if nobody moved them meanwhile). If the Mac itself dies, cuts are at most 15 dB (speech) / 8 dB (music) and singer mutes are visible in the X Air app | Test |
| M4 | A pause between songs flips the service mode | Hold times: worship needs 2.5 s, talking-over-music 1.5 s after singing stops, speaking 6 s after music stops (about 10 s in all); singers are only muted after 20 s of speaking | Test |
| M5 | A long steady pad counts as silence | Noise floor creeps up very slowly and is capped at -60 dB | Test |
| M6 | Duck still on when the next song starts | Ducking applies only while music is actually playing, and releases fast when worship starts | Test |
| M7 | Meters are post-fader on the real mixer, so turning a mic down makes the auto-mix turn it down further | Assumed pre-fader (P2). If midweek shows otherwise, set `"automix": { "metersPostFader": true }` in config.json | Midweek |
| M8 | Speech mic picks up loud music and counts as "talking" | Possible with omni earsets near the band. Watch for it midweek; tune `activeAboveFloorDb` | Midweek |
| M12 | The app changes the band's in-ear mixes | Never: it only moves channel faders and never mutes channels or touches aux sends (tested). Needs the in-ear sends to be **pre-fader**, which is checked midweek. *Changed in 0.3.4: singers are turned down with the fader instead of muted, because a mute also cut them from the in-ears* | Test, Midweek |
| M13 | A song's mix changes the in-ears or pushes something up | The song mix is fader cuts only (0 to -24 dB), house only, during worship only; tested that the auto-mix never sends mutes or aux sends | Test |
| M16 | ProPresenter jumps to the wrong song, or the network blocks it | Only songs in today's set are matched, loosely by title; anything else changes nothing. The engineer can switch following off with one tap and still tap songs. A dropout keeps the current song and shows a plain-English "can't reach" note with what to check. Address must be a local-network IP or .local name, so the Mac can't be pointed at the internet | Tests, Browser, Midweek |
| M17 | Channels change every week (not per song) | "This week's channels" step at the top of soundcheck, reopened for every new set; each person starts from their last channel; Find by listening compares against the loudest each channel was in the 4 s before and needs the channel to stay lit a third of the time, so click, tracks and other singers aren't picked; channels used by others this week are skipped. Song rows only show the channel | Tests, Browser (simulated singer on a busy channel; nobody singing gives "didn't hear") |
| M15 | "Use what I'm hearing" picks the wrong lead | It's only a suggestion, shown in words before anyone taps it, and needs 10 seconds of the song. It favours the singer who is active most and loudest; a loud harmony line or stage bleed into a vocal mic can mislead it, so the engineer confirms by ear. Tiles show live levels to help | Browser, Midweek |
| M14 | Wrong people emphasised after the band changes | Leads are stored per person and only filled in from memory when that person is on stage this week; mono/stereo per person decides which channels are used (tested) | Test |
| P7 | Planning Center token leaks to iPads | Token stored only on the Mac (file mode 600), entered only from the Mac's own screen, never included in anything sent to devices (tested) | Test |
| P8 | Planning Center unreachable on Sunday | Plans are imported ahead of time and kept; clear message when the Mac has no internet | Test |
| M9 | Singer mic muted for the sermon while someone talks on it (worship leader praying after the sermon) | A singer mic is only muted if it has been silent for the whole 20 s; a singer mic used for talking with no music counts as speaking. If someone starts talking into a mic it muted, it unmutes at once (needs the meters to read before the mute: confirm midweek). *Fixed in 0.3.3* | Test, Midweek |
| M10 | Pre/post-service music stays loud under a welcome | It ducks under any talking, in any mode; a fade in progress is never interrupted; the saved music level is the one a person set, not the ducked one. *Fixed in 0.3.3* | Test |
| M11 | Worship leader talks over a keys pad on their vocal mic: app can't tell talking from singing, so no duck | Known limit. Tap "Talking over music" for that moment | — |

## Pre/post-service music player

| # | Failure | What handles it | Check |
|---|---|---|---|
| W1 | A pasted "playlist link" is used to run other commands on the Mac | Spotify links are reduced to a strict `spotify:playlist:ID` form or refused; Apple Music names are escaped before use (tested with an injection attempt) | Test |
| W2 | macOS blocks control of Spotify | The app says exactly which setting to turn on (Privacy & Security → Automation) | Midweek |
| W3 | The status check keeps opening Spotify | It only asks Spotify for status if it's already running | Test |
| W4 | No internet on Sunday (Mac on the mixer's Wi-Fi) | Player shows that only downloaded playlists will play; NETWORK.md explains downloading during the week | Test |
| W5 | Fade music out pauses music someone just brought back up | The pause after the fade only happens if the music channel is still off | Test |
| W6 | iPads are shown an address they can't reach (Mac on two networks) | The Mac's address on the mixer's network is listed first | Design |
| W7 | Practice mode starts the real Spotify | Practice mode uses a pretend player | Design |

## Not yet built (tracked in ROADMAP.md)

Profiles, soundcheck assistant, feedback detection (needs a native macOS audio helper and microphone permission), effects control, vocal riding during worship, plain-English assistant.
