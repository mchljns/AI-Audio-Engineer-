# Your system: gain staging and setup

Written for this setup:

```
XR18 main out ──► JBL PRX ONE (stage right, built-in sub)
                     └─ XLR pass-thru ──► Fender Passport Venue (one speaker, fill on the other side)

Helix Stadium ◄─USB-C─ iPad (Loop Community Prime)
   └─ Matrix Mixer: FOH outputs, monitor/click outputs ──► XR18 inputs
NUX Stageman Floor (acoustic DI) ──► XR18
Phenyx Pro PTU-7000-4H (4 mics), Shure BLX14R (pastor) ──► XR18
XR18 aux buses ──► 2× Phenyx Pro PTM-10 ──► in-ears
```

The rule for the whole system: **all mixing happens on the XR18** (where Mix Assistant works). The PRX ONE and the Passport are set once, marked, and left alone.

## 1. Your PA is mono, so pan to the centre

Both speakers get the same single feed: the PRX ONE passes its input mix on to the Passport. So:

- Anything panned left or right on the XR18 gets quieter. If only **one** XR18 main output is wired, it can disappear entirely: Keys R and the right half of every reverb go nowhere.
- **Pan every channel to the centre** in the X Air app, including both halves of stereo keys and tracks. Mix Assistant now flags any channel that's panned off-centre in the pre-service check.
- If both XR18 main outputs (L and R) go into two PRX ONE inputs, the PRX adds them together. Off-centre pans then lose less, but centring is still the safe choice.

## 2. The PRX ONE

Its pass-thru doesn't just copy one input. It sends **a mix of every PRX ONE input**, with its own level control and high- and low-pass filters (set in the JBL Pro Connect app or on the PRX's screen). That means:

- **Use only the input(s) the XR18 feeds.** Turn every other PRX input all the way down. Anything plugged into another input also goes to the Passport.
- **Turn Bluetooth off** on the PRX ONE during services. Bluetooth audio can still reach the pass-thru, so someone's phone could play through both speakers.
- XR18 input channel(s) on the PRX: **EQ flat, effects off** (no reverb, chorus or delay; the XR18 does effects).
- **Input gain:** start low. Play the band at service level and raise it until the PRX's input meter shows strong signal but never clip. A line signal from the XR18 needs far less gain than a microphone.
- **Master volume:** set with a phone SPL meter in the middle of the room: about **75–80 dBA** for speaking and **85–90 dBA** at the loudest in worship.
- **Pass-thru level:** start at 0 dB. Set the Passport's level from its own knob (step 3).
- **Pass-thru high-pass filter: set it around 100 Hz.** This leaves the low end to the PRX ONE's sub, and the Passport's EQ can stay flat. That's cleaner than turning the Passport's bass knob down.

Before setting the levels, check one thing: turn the PRX master down and see if the Passport gets quieter too. If it does, the pass-thru follows the master, so set the PRX master first and the Passport second, and don't touch the PRX master afterwards.

## 3. The Passport Venue fill

- Plug the pass-thru into a **mic/line combo input** on the Passport, and keep that channel's level low to start. Pass-thru is line level.
- **EQ flat, effects off.** The PRX's pass-thru filter already removes the low end.
- **Level by walking the room**, as you do now: stand where the PRX ONE and the Passport are about equally loud. The voice should seem to come from the stage, not from one side.
- Both speakers are about the same distance from the stage, so **no delay is needed**. If the Passport ever moves to the back of the room as a delay fill, it would need about 1 ms of delay per foot of extra distance.
- Mark the knobs with tape once set.

## 4. The XR18 side

- **Channel gain:** normal singing or speaking peaks around **-18 to -12** on the channel meter.
- **Main L/R fader at 0 dB.** In a normal song the main meter peaks around **-12 to -6**, and never red.
- Mix Assistant only turns channels **down** from where you set them, so set these levels at soundcheck as the loudest you'll want.

## 5. Your vocal chain, reviewed

Your order (HPF and EQ → gate → compressor) is right. Two changes will help with your noise floor:

| Setting | Yours | Suggested | Why |
|---|---|---|---|
| Gate threshold | -40 to -38 dB | Keep | Good place to start |
| Gate type | Gate | **Expander, 10–15 dB range** | A full gate makes the hiss switch on and off audibly. An expander turns it down between phrases instead |
| Compressor ratio | 4:1 | **3:1** | 4:1 with 6–10 dB of reduction is heavy for worship vocals and brings up breath and room noise |
| Gain reduction | 6–10 dB | **3–6 dB** | Less squashing and less noise brought up |
| Makeup gain | +6 to +10 dB | **+2 to +4 dB** | **This is the biggest noise source.** Every dB of makeup also raises the hiss and the room between phrases, and costs feedback headroom. Get level from the preamp gain and the receiver output instead |

**Pastor (Shure omni earset):** lighter again: 3:1, 3–6 dB reduction, makeup +2 dB at most. An omni mic hears the whole room, so makeup gain mostly turns up the room and the monitors.

Mix Assistant also mutes the singer mics during the sermon, so their gates only need to handle the gaps within worship.

## 6. Wireless mics and in-ears

Your PTU-7000 routine is the right one: scan each channel by itself with everything else powered on, IR sync, use the XLR outs, keep the receiver output high and the XR18 gain lower, and add an HPF and a light gate. Two additions:

- **Do the scan with the PTM-10 in-ear transmitters switched on and transmitting.** In-ear transmitters in the same rack are the most likely thing to interfere with the mic receivers.
- **Keep the in-ear transmitter antennas away from the mic receiver antennas.** At least 1–2 feet apart if possible, and not side by side on the same plate. The transmitters are loud, close-by RF sources for the receivers.

## 7. Helix Stadium: keep the click out of the guitar channel

The click lock works on the XR18 channel named Click. It **can't** remove a click that the Helix has mixed into the *guitar* output: on the XR18 that's just the guitar channel.

- In the Helix **Matrix Mixer**, make sure the click and guide go **only** to the monitor/click outputs, never to the FOH outputs.
- Save that routing with the preset or setlist, so a preset change can't undo it.
- **Check at every soundcheck:** start a Prime song with the guitar silent and listen to the XR18 guitar channel (solo it in the X Air app, or watch its meter). Any meter movement means click is leaking into FOH.
- Name the XR18 input channels clearly: "Helix L", "Helix R", "Click", "Guide", "Trk 1". Mix Assistant recognises Helix, HX and Stadium as guitar.

## 8. NUX Stageman Floor

- Power: **9 V DC, centre-negative, at least 180 mA**, ideally from an isolated pedal supply. A noisy or shared supply is a common cause of hum.
- XLR out to the XR18 with **phantom power off** on that channel.
- If you hear a hum that stops when the cable is unplugged from the NUX, use its **ground lift**.

## 9. In-ear buses

Name each XR18 aux bus that feeds a PTM-10 in the X Air app, for example "IEM Vocals" and "IEM Band". Mix Assistant then knows they're in-ear mixes, where the click is allowed. An unnamed bus with click on it shows a warning until you name it.

## Still to confirm

- **Is one XR18 main output wired to the PRX ONE, or both (L and R)?**
- **Which Helix outputs go into which XR18 channels?** In particular, do the click and guide come into the XR18 on their own channels, so everyone's in-ears get them from the XR18?
- **Are the PTM-10s in stereo or mono mode?** That decides whether you have 2 or 4 in-ear mixes.
