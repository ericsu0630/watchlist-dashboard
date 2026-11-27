#!/bin/bash
# Builds Watchlist.app (menu bar app + Node + the dashboard) and a .dmg, in dist/.
# Usage: bash macapp/build.sh
# Needs Xcode's command line tools, Node 20.19+ for Apple Silicon (the one on PATH, or WD_NODE=/path/to/node),
# and node_modules from `npm install`. Nothing is downloaded.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/dist"
NODE="${WD_NODE:-$(command -v node || true)}"
APP="$OUT/Watchlist.app"
BUNDLE_ID="com.ericsu.watchlist"

[ -x "$NODE" ] || { echo "node not found; set WD_NODE=/path/to/node"; exit 1; }
[ "$(lipo -archs "$NODE")" = "arm64" ] || { echo "$NODE is not an Apple Silicon (arm64) build"; exit 1; }
"$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)' \
  || { echo "Node 20.19 or newer is needed ($NODE is $("$NODE" -v))"; exit 1; }
# The bundled node must only use system libraries, so it runs on any Mac.
if otool -L "$NODE" | tail -n +2 | grep -vqE '^\s+/(usr/lib|System/Library)/'; then
  echo "$NODE links libraries outside the system:"; otool -L "$NODE"; exit 1
fi
[ -d "$ROOT/node_modules" ] || { echo "Run npm install first"; exit 1; }
VERSION="$("$NODE" -p "require('$ROOT/package.json').version")"

echo "Building Watchlist $VERSION with Node $("$NODE" -v)…"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/app"

swiftc -O -target arm64-apple-macos13.0 "$HERE/main.swift" -o "$APP/Contents/MacOS/Watchlist"
# Node keeps its own (Node.js Foundation, notarized) signature.
cp "$NODE" "$APP/Contents/MacOS/node"

# Only what the server needs: this leaves out .env, data/, .claude-tests/, .git, docs and the menubar tools.
rsync -a --exclude '.DS_Store' \
  "$ROOT/server.js" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/lib" "$ROOT/public" "$ROOT/node_modules" \
  "$APP/Contents/Resources/app/"
# Drop any dev-only packages (offline; nothing is fetched).
(cd "$APP/Contents/Resources/app" && PATH="$(dirname "$NODE"):$PATH" npm prune --omit=dev --offline --no-audit --no-fund --silent)

# Icon
ICONSET="$OUT/build/Watchlist.iconset"
rm -rf "$OUT/build" && mkdir -p "$ICONSET"
swift "$HERE/icon.swift" "$OUT/build/icon.png"
for s in 16 32 128 256 512; do
  sips -z $s $s "$OUT/build/icon.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) "$OUT/build/icon.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/Watchlist.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Watchlist</string>
  <key>CFBundleDisplayName</key><string>Watchlist</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>Watchlist</string>
  <key>CFBundleIconFile</key><string>Watchlist</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSArchitecturePriority</key><array><string>arm64</string></array>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF

# Ad-hoc signature (no Apple Developer account). Not notarized.
xattr -cr "$APP"
codesign --force --sign - --identifier "$BUNDLE_ID" "$APP"
codesign --verify --deep --strict "$APP"

echo "Making disk image…"
DMG="$OUT/Watchlist-$VERSION-arm64.dmg"
STAGE="$OUT/build/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -quiet -volname Watchlist -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$DMG"
rm -rf "$OUT/build"

echo "Done:"
echo "  $APP ($(du -sh "$APP" | cut -f1))"
echo "  $DMG ($(du -h "$DMG" | cut -f1))"
