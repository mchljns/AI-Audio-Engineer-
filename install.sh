#!/bin/bash
# Mix Assistant installer for macOS (Apple silicon or Intel).
#
#   curl -fsSL https://raw.githubusercontent.com/mchljns/AI-Audio-Engineer-/stable/install.sh | bash
#
# Installs everything into ~/MixAssistant without needing an administrator password:
#   ~/MixAssistant/node   its own copy of Node.js (doesn't touch anything else on the Mac)
#   ~/MixAssistant/app    the Mix Assistant code
#   ~/MixAssistant/data   your saved settings (kept when you update)
#   ~/MixAssistant/logs   what it's been doing, for troubleshooting
# runs Mix Assistant as a background service that starts when you log in, and puts two
# shortcuts on the Desktop. Running it again updates to the latest tested ("stable") version.
#
# MIX_CHANNEL=main  installs the newest untested work instead (for midweek testing only).

set -euo pipefail

# Everything is inside main(), called on the last line, so a download that's cut off
# part-way through can never run half an installer.
main() {

REPO="mchljns/AI-Audio-Engineer-"
BRANCH="${MIX_CHANNEL:-stable}"
NODE_LINE="latest-v22.x"
HOME_DIR="${MIX_HOME:-$HOME/MixAssistant}"
DESKTOP="${MIX_DESKTOP:-$HOME/Desktop}"
LABEL="com.mixassistant.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$1"; }
fail() { printf '\n\033[1;31mInstall stopped:\033[0m %s\n' "$1" >&2; exit 1; }

# ---- which Mac is this? ----
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin) NODE_OS=darwin ;;
  Linux) NODE_OS=linux ;; # for testing
  *) fail "This installer is for Mac." ;;
esac
case "$ARCH" in
  arm64|aarch64) NODE_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64 ;;
  *) fail "Unsupported processor: $ARCH" ;;
esac

sha256() { if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi | awk '{print $1}'; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$HOME_DIR/data" "$HOME_DIR/logs"

# Stop the running copy before replacing anything it uses (Node.js or the app).
stop_service

# ---- Node.js ----
say "Getting Node.js ($NODE_OS-$NODE_ARCH)…"
curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt" || fail "Couldn't reach nodejs.org. Is the Mac on the internet?"
NODE_TGZ="$(grep -oE "node-v[0-9.]+-$NODE_OS-$NODE_ARCH\.tar\.gz" "$TMP/SHASUMS256.txt" | head -1)"
[ -n "$NODE_TGZ" ] || fail "Couldn't find a Node.js download for this Mac."
NODE_VER="${NODE_TGZ%%-$NODE_OS*}"
if [ -x "$HOME_DIR/node/bin/node" ] && [ "$("$HOME_DIR/node/bin/node" --version)" = "${NODE_VER#node-}" ]; then
  echo "Already have ${NODE_VER#node-}."
else
  curl -fSL --progress-bar "https://nodejs.org/dist/$NODE_LINE/$NODE_TGZ" -o "$TMP/$NODE_TGZ" || fail "Node.js download failed."
  EXPECTED="$(grep " $NODE_TGZ\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')"
  [ "$(sha256 "$TMP/$NODE_TGZ")" = "$EXPECTED" ] || fail "Node.js download didn't verify. Try again."
  rm -rf "$HOME_DIR/node.new"
  mkdir -p "$HOME_DIR/node.new"
  tar -xzf "$TMP/$NODE_TGZ" -C "$HOME_DIR/node.new" --strip-components=1
  rm -rf "$HOME_DIR/node"
  mv "$HOME_DIR/node.new" "$HOME_DIR/node"
  echo "Installed Node.js ${NODE_VER#node-}."
fi
export PATH="$HOME_DIR/node/bin:$PATH"

# ---- the app ----
say "Downloading Mix Assistant ($BRANCH)…"
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/app.tgz" || fail "Couldn't download the app from GitHub."
mkdir -p "$TMP/app"
tar -xzf "$TMP/app.tgz" -C "$TMP/app" --strip-components=1
[ -f "$TMP/app/src/bridge.js" ] || fail "The download didn't look right."

say "Installing…"
(cd "$TMP/app" && npm ci --omit=dev --no-audit --no-fund --loglevel=error) || fail "Installing the app's parts failed."

rm -rf "$HOME_DIR/app.old"
[ -d "$HOME_DIR/app" ] && mv "$HOME_DIR/app" "$HOME_DIR/app.old"
mv "$TMP/app" "$HOME_DIR/app"
rm -rf "$HOME_DIR/app.old"

# ---- background service (macOS) ----
SERVICE=no
if [ "$OS" = "Darwin" ] && [ -z "${MIX_NO_SERVICE:-}" ]; then
  say "Setting Mix Assistant to run in the background…"
  mkdir -p "$HOME/Library/LaunchAgents"
  : > "$HOME_DIR/logs/bridge.log"
  cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$HOME_DIR/node/bin/node</string>
    <string>$HOME_DIR/app/src/bridge.js</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME_DIR/app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>DATA_DIR</key><string>$HOME_DIR/data</string>
    <key>PATH</key><string>$HOME_DIR/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/bridge.log</string>
</dict>
</plist>
PLIST_END
  for attempt in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then SERVICE=yes; break; fi
    sleep 1
  done
  if [ "$SERVICE" != yes ] && launchctl load -w "$PLIST" 2>/dev/null; then SERVICE=yes; fi
  if [ "$SERVICE" != yes ]; then
    echo "Couldn't start the background service. The Desktop shortcut will run it in a Terminal window instead."
  fi
fi

# ---- Desktop shortcuts ----
say "Adding shortcuts to your Desktop…"
mkdir -p "$DESKTOP"
MAIN_CMD="$DESKTOP/Mix Assistant.command"
PRACTICE_CMD="$DESKTOP/Mix Assistant (practice).command"

cat > "$MAIN_CMD" <<LAUNCH_END
#!/bin/bash
# Mix Assistant: opens the app. It normally runs in the background already.
PORT="\$(grep -o '"httpPort": *[0-9]*' "$HOME_DIR/data/config.json" 2>/dev/null | grep -o '[0-9]*\$' || true)"
URL="http://localhost:\${PORT:-8080}"
up() { curl -fs "\$URL/healthz" >/dev/null 2>&1; }
if ! up && [ -f "$PLIST" ]; then
  echo "Starting Mix Assistant…"
  launchctl kickstart -k "gui/\$(id -u)/$LABEL" >/dev/null 2>&1 || launchctl load -w "$PLIST" >/dev/null 2>&1
  for i in \$(seq 1 20); do up && break; sleep 0.5; done
fi
if up; then
  open "\$URL"
  exit 0
fi
# No background service: run it in this window instead.
echo "Running Mix Assistant in this window. Keep it open; closing it stops the app."
export PATH="$HOME_DIR/node/bin:\$PATH" DATA_DIR="$HOME_DIR/data"
cd "$HOME_DIR/app"
( sleep 3; open "\$URL" ) &
exec node src/bridge.js
LAUNCH_END

cat > "$PRACTICE_CMD" <<LAUNCH_END
#!/bin/bash
# Mix Assistant practice mode: a pretend mixer for learning and testing.
# Close this window (or press Ctrl+C) to stop practice mode. The real Mix Assistant isn't affected.
export PATH="$HOME_DIR/node/bin:\$PATH"
URL="http://localhost:8081"
if curl -fs "\$URL/healthz" >/dev/null 2>&1; then open "\$URL"; exit 0; fi
cd "$HOME_DIR/app"
echo "Starting practice mode (pretend mixer)…"
( sleep 3; open "\$URL" ) &
exec node src/dev.js
LAUNCH_END
chmod +x "$MAIN_CMD" "$PRACTICE_CMD"

say "Done!"
VERSION="$(grep -m1 '"version"' "$HOME_DIR/app/package.json" | sed -E 's/.*"([0-9.]+)".*/\1/')"
echo
echo "  Mix Assistant $VERSION is installed."
if [ "$SERVICE" = yes ]; then
  echo "  It runs in the background and starts by itself whenever you log in to this Mac."
  echo "  (macOS may show a \"Background Items Added\" notice. That's this.)"
fi
cat <<DONE_END

  On your Desktop:
    • Mix Assistant             opens the app (use with the real XR18)
    • Mix Assistant (practice)  a pretend mixer for learning

  iPads and phones: open the address shown at the top of the app on this Mac,
  then enter the PIN shown next to it.

  To update later, run the same install command again. Your settings are kept.

DONE_END

if [ "$OS" = "Darwin" ] && [ -z "${MIX_NO_LAUNCH:-}" ]; then
  if [ "$SERVICE" = yes ]; then
    echo "Opening Mix Assistant…"
    sleep 2
    open "http://localhost:8080"
  fi
  echo "Opening practice mode so you can look around…"
  open "$PRACTICE_CMD"
fi
}

# Stop the background service and wait until macOS has really let go of it.
stop_service() {
  [ "$OS" = "Darwin" ] || return 0
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0
  for i in $(seq 1 20); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || return 0
    sleep 0.5
  done
}

main "$@"
