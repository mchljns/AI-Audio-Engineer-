# Network: iPads on the mixer's Wi-Fi, Spotify still working

## Your setup: rack on stage, laptop on the rack, set up and torn down each week

The XR18 makes its own Wi-Fi, so the simplest setup is **everything on the mixer's Wi-Fi**: the laptop and the iPad both join it, nothing depends on the venue's internet, and it's the same every Sunday. Spotify plays playlists downloaded during the week (Option 1 below), and Prime already plays its tracks from the laptop.

**Once, at home during the week:**
1. On the laptop: **System Settings → Wi-Fi → the XR18's network → Details**: turn on **Auto-Join**. If the laptop also knows the venue's Wi-Fi, turn **Auto-Join off** for that one, so the laptop always lands on the mixer's network at the venue.
2. Still in that XR18 network's Details → **TCP/IP**: set Configure IPv4 to **Using DHCP with manual address** and enter `192.168.1.50` (if the XR18's network uses a different range, use the same first three numbers with .50). The laptop then has the same address every week.
3. In Spotify on the laptop, **download** the pre- and post-service playlists (needs Premium).
4. Turn on **automatic login** for the laptop (System Settings → Users & Groups), so Mix Assistant is running as soon as it starts.

**Once, on the iPad:**
1. Join the XR18's Wi-Fi and open Safari at `http://192.168.1.50:8080` (the address in the blue badge on the laptop). Enter the PIN.
2. Tap **Share → Add to Home Screen**. Because the laptop's address never changes, this icon works every week.

**Every Sunday:**
1. Power the rack, open the laptop. Mix Assistant starts by itself and finds the mixer.
2. On the iPad, join the XR18's Wi-Fi if it didn't join by itself, and tap the Mix Assistant icon.
3. Keep using the **X Air app** for anything Mix Assistant doesn't do (in-ear mixes, EQ, scenes). Both can be open at once; switch between them freely. The auto-mix runs on the laptop, so it keeps working while the iPad is in the X Air app or asleep.

**Tear-down:** close the laptop and power down. Nothing needs saving: the mixer keeps its own settings, and Mix Assistant keeps its settings on the laptop.

Notes:
- The XR18's Wi-Fi may only allow about **4 devices** at once. The laptop counts as one, and each iPad or phone counts as one.
- The laptop's name (shown when you hover over the blue badge, e.g. `http://booth-mac.local:8080`) also works on the iPad, but the fixed address above is the most reliable.
- Keep the laptop open during the service: closing the lid puts it to sleep.

The options below are for when you want Spotify to stream rather than play downloads.


**The catch:** a Mac has one Wi-Fi radio, so it can be on the XR18's Wi-Fi **or** the church Wi-Fi, not both. The XR18's own Wi-Fi has no internet. So if the Mac joins the mixer's Wi-Fi (to host the iPads), Spotify needs another way to play. Here are the options with no new hardware, best first.

## Option 1: Mac and iPads on the XR18's Wi-Fi, Spotify plays downloaded playlists (recommended)

Everything runs on the mixer's own network, with no dependence on church Wi-Fi.

1. **During the week, at home or the office:** in Spotify on the booth Mac, open each pre/post-service playlist and switch on **Download** (needs Spotify Premium). Wait until every song shows the green download arrow.
2. **On Sunday:** join the Mac and the iPads to the XR18's Wi-Fi. Open the app on the iPads at the address shown in the blue badge on the Mac.
3. Tap **Fade music in** on the iPad. Downloaded songs play without internet. The app shows a note on the player when the Mac is offline, as a reminder that only downloaded playlists will play.

Things to know:
- Spotify needs the Mac to go online at least **once every 30 days** to keep downloads playable. Connecting it to any Wi-Fi during the week does this.
- Add new songs during the week, not Sunday morning.
- The XR18's own Wi-Fi may only allow **4 devices** at once (the Mac counts as one). If an iPad can't join, that's likely why: use Option 4, or have spare devices stay off it.

## Option 2: Mac on the XR18's Wi-Fi, internet over a cable

If there's a church network jack at the booth, plug the Mac into it with an Ethernet cable (needs a USB-C to Ethernet adapter on most Macs). Spotify streams over the cable while the Mac hosts the iPads on the mixer's Wi-Fi.

Set the Mac to use the cable for internet: **System Settings → Network → ⋯ (bottom) → Set Service Order**, then drag the Ethernet adapter **above** Wi-Fi. Otherwise the Mac may try to reach the internet through the mixer's Wi-Fi.

## Option 3: Mac on the XR18's Wi-Fi, internet from an iPhone over its cable

Same as Option 2, using a phone you already have: connect an iPhone to the Mac with its charging cable and turn on **Personal Hotspot** on the phone. Then, in Set Service Order, drag **iPhone USB** above Wi-Fi. Uses the phone's data plan; music is roughly 50–150 MB an hour.

## Option 4: everything on the church Wi-Fi (no mixer Wi-Fi)

The XR18 joins the church Wi-Fi instead of making its own (X Air app → Setup → Network → Wi-Fi mode **Client**, choose the church network, enter its password). The Mac and iPads use the church Wi-Fi too, so Spotify streams normally.

- Use the **staff** network, not guest Wi-Fi: guest networks usually stop devices seeing each other, and the mixer has no password of its own.
- The XR18 only uses **2.4 GHz** Wi-Fi.
- Depends on the church Wi-Fi being reliable at the booth on Sunday.

## Which address do iPads use?

The blue badge at the top of Mix Assistant on the Mac shows it, with the address on the mixer's network listed first, then the PIN. Enter the PIN once on each iPad; it's remembered.
