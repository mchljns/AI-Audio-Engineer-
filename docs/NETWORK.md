# Network setup (no new hardware, Spotify keeps working)

The booth Mac needs two things at once: the **internet** (Spotify) and the **XR18**. Pick one of these.

## Option 1: put the XR18 on the church Wi-Fi (recommended, no cables)

The XR18 can join an existing Wi-Fi network instead of making its own. Then the Mac, the iPads and the mixer are all on the church Wi-Fi, and Spotify works as normal.

1. Connect an iPad to the XR18's own Wi-Fi as you do today and open the X Air app.
2. Go to **Setup → Network**. Set the Wi-Fi mode to **Client**, choose the church network, enter its password, and leave it on **DHCP**. Apply.
3. The XR18 joins the church Wi-Fi. Join the Mac and the iPads to the same network.
4. Mix Assistant finds the mixer by itself, and finds it again if the router ever gives it a new address.

Things to check:
- **Use the staff network, not guest Wi-Fi.** Guest networks usually stop devices from seeing each other, so the app wouldn't find the mixer. And the XR18 has no password of its own: anyone on its network with the X Air app can control it.
- The XR18 only uses **2.4 GHz** Wi-Fi (channels 1–11), with WPA2. Most church routers offer this alongside 5 GHz.
- If the church Wi-Fi is unreliable at the booth, use Option 2.

## Option 2: one Ethernet cable from the Mac to the XR18

Most reliable. The Mac stays on church Wi-Fi for Spotify, and talks to the mixer over the cable. iPads reach the mixer *through* Mix Assistant on the Mac.

With no router on the cable, both ends need a fixed address:
1. **XR18:** in the X Air app, **Setup → Network → LAN**: set a fixed IP of `192.168.2.10`, subnet mask `255.255.255.0`.
2. **Mac:** **System Settings → Network → Ethernet → Details → TCP/IP**: Configure IPv4 **Manually**, IP address `192.168.2.20`, subnet mask `255.255.255.0`, leave Router empty.
3. Plug the cable in. Mix Assistant finds the mixer on the cable.

Trade-off: iPads use Mix Assistant (over church Wi-Fi) to control the mixer. The X Air app on an iPad can only reach the mixer if the XR18's own Wi-Fi is also left on.

## Spotify tip

Download the walk-in playlist for offline listening (Spotify Premium). If the church internet drops on Sunday morning, walk-in music keeps playing.
