#!/bin/bash
# Mix Assistant installer for macOS (Apple silicon or Intel).
#
#   curl -fsSL https://raw.githubusercontent.com/mchljns/AI-Audio-Engineer-/main/install.sh | bash
#
# Installs everything into ~/MixAssistant without needing an administrator password:
#   ~/MixAssistant/node   its own copy of Node.js (doesn't touch anything else on the Mac)
#   ~/MixAssistant/app    the Mix Assistant code
#   ~/MixAssistant/data   your saved settings (kept when you update)
# and puts two shortcuts on the Desktop. Running it again updates to the latest version.

set -euo pipefail

REPO="mchljns/AI-Audio-Engineer-"
BRANCH="main"
NODE_LINE="latest-v22.x"
HOME_DIR="${MIX_HOME:-$HOME/MixAssistant}"
DESKTOP="${MIX_DESKTOP:-$HOME/Desktop}"

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
mkdir -p "$HOME_DIR/data"

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
say "Downloading Mix Assistant…"
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

# ---- Desktop shortcuts ----
say "Adding shortcuts to your Desktop…"
mkdir -p "$DESKTOP"
write_launcher() {
  local file="$1" title="$2" entry="$3"
  cat > "$file" <<EOF
#!/bin/bash
# $title — double-click to start. Close this window (or press Ctrl+C) to stop.
export PATH="$HOME_DIR/node/bin:\$PATH"
export DATA_DIR="$HOME_DIR/data"
URL="http://localhost:8080"
if curl -fs "\$URL/api/state" >/dev/null 2>&1; then
  echo "Mix Assistant is already running. Opening it…"
  open "\$URL"
  exit 0
fi
cd "$HOME_DIR/app"
echo "Starting $title…"
( sleep 3; open "\$URL" ) &
exec node $entry
EOF
  chmod +x "$file"
}
write_launcher "$DESKTOP/Mix Assistant.command" "Mix Assistant" "src/bridge.js"
write_launcher "$DESKTOP/Mix Assistant (practice).command" "Mix Assistant practice mode (pretend mixer)" "src/dev.js"

say "Done!"
cat <<EOF

  Mix Assistant is installed.

  On your Desktop:
    • Mix Assistant.command             — use with the real XR18
    • Mix Assistant (practice).command  — try it with a pretend mixer

  Double-click one to start. A browser window opens with the app.
  To update later, run the same install command again. Your settings are kept.

EOF

if [ "$OS" = "Darwin" ] && [ -z "${MIX_NO_LAUNCH:-}" ]; then
  echo "Opening practice mode now so you can look around…"
  open "$DESKTOP/Mix Assistant (practice).command"
fi
