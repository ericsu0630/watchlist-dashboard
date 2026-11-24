#!/bin/bash
# Builds the menu bar app and registers it to start at login (LaunchAgent).
# Usage: bash menubar/install.sh        (re-run after moving the repo or changing node versions)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
DIR="$(dirname "$HERE")"
NODE="${WD_NODE:-$(command -v node)}"
PORT="${PORT:-3000}"
# 0.0.0.0 makes the server reachable over Tailscale/LAN. Use HOST=127.0.0.1 for this Mac only.
HOST="${HOST:-0.0.0.0}"
LABEL="com.ericsu.watchlist-dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HERE/WatchlistMenu"

[ -x "$NODE" ] || { echo "node not found; set WD_NODE=/path/to/node"; exit 1; }
[ -d "$DIR/node_modules" ] || (cd "$DIR" && npm install)

echo "Building…"
swiftc -O "$HERE/main.swift" -o "$BIN"

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>WD_NODE</key><string>$NODE</string>
    <key>WD_DIR</key><string>$DIR</string>
    <key>WD_PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOST</string>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><false/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

# Reload (stops any running copy first)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 2
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. Menu bar icon should be visible; server at http://localhost:$PORT"
