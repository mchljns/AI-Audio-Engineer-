# QA record

A running list of what could go wrong, what handles it, and how it's checked. Reviewed before each release. "Test" means an automated test in `test/`; "Midweek" means it can only be confirmed on the real XR18.

## Safety: what reaches the congregation

| # | Failure | What handles it | Check |
|---|---|---|---|
| S1 | Click or guide assigned to the main speakers (by another app, a scene recall or a mistake) | Click guard turns main L/R off within moments of the mixer reporting it, and alerts | Test, Midweek |
| S2 | Click or guide sent to an effect (reverb/delay returns feed the house) | Guard zeroes FX1–4 sends | Test, Midweek |
| S3 | Click or guide sent to a monitor bus people outside the band hear (livestream, lobby, pastor wedge) | Guard zeroes sends to "protected" buses, worked out from bus names or set in `config.json` (`protectedBuses`). In-ear buses are left alone | Test |
| S4 | Click channel renamed, so it's no longer recognised by name | Lock is sticky: the channel stays protected and the volunteer is warned until a person sets what the channel is now | Test |
| S5 | Click lands on a channel that was never named Click (Prime routing changed) | **Open.** Mixer setup is the first defence (LR off and recall-safe on click/guide). Recognising the click by sound is planned with audio analysis | — |
| S6 | Mix Assistant stops (crash, Mac asleep, update) | Audio never passes through it; the mixer keeps its current settings. The background service restarts it within ~10 s | Midweek |
| S7 | App stops mid-fade | Fade stops where it is. Harmless for walk-in. **Rule for future automation:** anything the app holds (ducking) must be done by the mixer itself, so nothing is left stuck if the app stops | Design rule |
| S8 | Someone moves a fader the app is fading | The fade stops; the person wins | Test |
| S9 | "Mute unused" mutes something in use | Only mutes channels with no name, no signal in the last 15 s, and never click/guide | Test |
| S10 | Bringing walk-in back up blasts at the old level | Starts from silence and fades to the saved level | Test |

## Access

| # | Failure | What handles it | Check |
|---|---|---|---|
| A1 | Someone on the church Wi-Fi opens the app and changes the mix | 4-digit PIN for every device except the booth Mac itself; shown only on the Mac's own screen; remembered per device | Test |
| A2 | PIN guessed by trying many | 5 wrong tries locks that device out for a minute | Test |
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
| C6 | A change pushed by the mixer is missed | Everything is re-read every 30 s and the lock re-checked | Design |
| C7 | Direct Mac-to-XR18 cable gets no IP address | **Setup:** use a router, or set fixed addresses. Documented | Setup |

## Mixer protocol (confirm on the real XR18)

| # | Assumption | Status |
|---|---|---|
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
| I3 | Update leaves a half-replaced app | New copy is fully installed before the old one is swapped out; service stopped first | Test |
| I4 | Settings lost on update | Settings, roles, locks and config live in `~/MixAssistant/data`, untouched by updates | Test |
| I5 | Volunteer closes the Terminal window and the app stops | Runs as a background service; the Desktop shortcut just opens the page | Midweek |
| I6 | Mac sleeps during service | Bridge holds idle sleep off while running. **Closing the lid still sleeps** a laptop without an external display | Setup |
| I7 | Mac restarts | Service starts at login. **The Mac must log in** (turn on automatic login, or someone logs in) | Setup |
| I8 | Log file grows forever | Truncated on each install; the bridge logs little (search messages throttled to every 5 min) | Design |

## Not yet built (tracked in ROADMAP.md)

Service modes and ducking (must follow S7), profiles, soundcheck assistant, feedback detection (needs a native macOS audio helper and microphone permission), effects control, plain-English assistant.
