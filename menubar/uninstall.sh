#!/bin/bash
# Stops the menu bar app and removes the start-at-login entry.
LABEL="com.ericsu.watchlist-dashboard"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" "$(dirname "$0")/WatchlistMenu"
echo "Removed."
