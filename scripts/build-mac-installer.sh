#!/bin/bash
# Builds dist/Mix-Assistant-Installer.zip: a double-clickable macOS installer app that wraps install.sh.
# Run after changing install.sh or macos/installer-launch.sh (a test checks they're in sync).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=dist
STAGE="$(mktemp -d)"
APP="$STAGE/Mix Assistant Installer.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$OUT"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Mix Assistant Installer</string>
  <key>CFBundleDisplayName</key><string>Mix Assistant Installer</string>
  <key>CFBundleIdentifier</key><string>com.mixassistant.installer</string>
  <key>CFBundleExecutable</key><string>install</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(node -p "require('./package.json').version")</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST
cp macos/installer-launch.sh "$APP/Contents/MacOS/install"
cp install.sh "$APP/Contents/Resources/install.sh"
chmod 755 "$APP/Contents/MacOS/install" "$APP/Contents/Resources/install.sh"
# Fixed timestamps so rebuilding without changes gives the same zip.
find "$STAGE" -exec touch -h -t 202601010000 {} +
rm -f "$OUT/Mix-Assistant-Installer.zip"
(cd "$STAGE" && zip -qrX -y "$OLDPWD/$OUT/Mix-Assistant-Installer.zip" "Mix Assistant Installer.app")
rm -rf "$STAGE"
echo "Built $OUT/Mix-Assistant-Installer.zip"
