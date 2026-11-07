#!/bin/bash
# Mix Assistant Installer. Double-click to install or update Mix Assistant. No Terminal needed.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
TITLE="Mix Assistant Installer"
LOG="$HOME/Library/Logs/MixAssistant-install.log"
APPS_DIR="${MIX_APPS:-$HOME/Applications}"

ask=$(osascript -e "display dialog \"This sets up Mix Assistant on this Mac:\n\n• the Mix Assistant app\n• its own copy of Node.js (nothing else on the Mac is changed)\n• a background service that starts when you log in\n\nIt takes about 2 minutes, needs the internet, and needs no password. If Mix Assistant is already installed, this updates it and keeps your settings.\" buttons {\"Cancel\", \"Install\"} default button \"Install\" with title \"$TITLE\"" 2>/dev/null) || exit 0
case "$ask" in *Install*) ;; *) exit 0 ;; esac

mkdir -p "$(dirname "$LOG")"
# A "please wait" message that closes by itself when the install finishes.
osascript -e "display dialog \"Installing Mix Assistant…\n\nThis takes about 2 minutes. This message closes by itself when it's done.\" buttons {\"Hide\"} default button \"Hide\" with title \"$TITLE\" giving up after 900" >/dev/null 2>&1 &
WAIT_PID=$!

if MIX_NO_LAUNCH=1 /bin/bash "$RES/install.sh" >"$LOG" 2>&1; then
  kill "$WAIT_PID" 2>/dev/null
  osascript -e "display dialog \"Mix Assistant is installed.\n\nIt starts by itself whenever you log in. Open it any time with the Mix Assistant app on your Desktop.\n\nmacOS may show a \\\"Background Items Added\\\" notice: that's Mix Assistant.\" buttons {\"Open Mix Assistant\"} default button 1 with title \"$TITLE\"" >/dev/null 2>&1
  open "$APPS_DIR/Mix Assistant.app"
else
  kill "$WAIT_PID" 2>/dev/null
  REASON="$(grep -m1 'Install stopped' "$LOG" | sed 's/.*Install stopped: *//; s/"/\\"/g')"
  [ -n "$REASON" ] || REASON="Something went wrong."
  btn=$(osascript -e "display dialog \"The install didn't finish.\n\n$REASON\n\nNothing on the Mac was changed that needs undoing. You can run the installer again.\" buttons {\"Show details\", \"OK\"} default button \"OK\" with icon caution with title \"$TITLE\"" 2>/dev/null)
  case "$btn" in *details*) open -e "$LOG" ;; esac
  exit 1
fi
