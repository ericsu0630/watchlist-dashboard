#!/bin/bash
# Builds the Windows version (tray app + Node + the dashboard) as a zip in dist/, on a Mac.
# Usage: bash winapp/build.sh            (x64)
#        WD_ARCH=arm64 bash winapp/build.sh
# Needs Go 1.26+, Xcode's command line tools (for the icon), Node 20.19+ on PATH and node_modules from
# `npm install`. Downloads the Windows Node.js zip of the same version as the local node (or WD_WIN_NODE_VERSION)
# from nodejs.org once, checks it against SHASUMS256.txt and keeps it in dist/cache.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
OUT="$ROOT/dist"
ARCH="${WD_ARCH:-x64}"
case "$ARCH" in
  x64) GOARCH=amd64; PE="x86-64" ;;
  arm64) GOARCH=arm64; PE="Aarch64" ;;
  *) echo "WD_ARCH must be x64 or arm64"; exit 1 ;;
esac

for tool in go node npm swift curl shasum unzip zip rsync file; do
  command -v "$tool" >/dev/null || { echo "$tool not found"; exit 1; }
done
[ -d "$ROOT/node_modules" ] || { echo "Run npm install first"; exit 1; }
VERSION="$(node -p "require('$ROOT/package.json').version")"
NODE_VERSION="${WD_WIN_NODE_VERSION:-$(node -v)}"
NODE_VERSION="v${NODE_VERSION#v}"
node -e 'const [a,b]=process.argv[1].slice(1).split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)' "$NODE_VERSION" \
  || { echo "Node 20.19 or newer is needed (got $NODE_VERSION)"; exit 1; }

# Windows Node.js, verified against the release's checksums.
NODE_ZIP="node-$NODE_VERSION-win-$ARCH.zip"
CACHE="$OUT/cache"
mkdir -p "$CACHE"
curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
EXPECTED="$(awk -v f="$NODE_ZIP" '$2 == f { print $1 }' "$CACHE/SHASUMS256-$NODE_VERSION.txt")"
[ -n "$EXPECTED" ] || { echo "$NODE_ZIP isn't listed in SHASUMS256.txt"; exit 1; }
if [ ! -f "$CACHE/$NODE_ZIP" ] || [ "$(shasum -a 256 "$CACHE/$NODE_ZIP" | cut -d' ' -f1)" != "$EXPECTED" ]; then
  echo "Downloading $NODE_ZIP…"
  curl -fL --progress-bar "https://nodejs.org/dist/$NODE_VERSION/$NODE_ZIP" -o "$CACHE/$NODE_ZIP.part"
  mv "$CACHE/$NODE_ZIP.part" "$CACHE/$NODE_ZIP"
fi
[ "$(shasum -a 256 "$CACHE/$NODE_ZIP" | cut -d' ' -f1)" = "$EXPECTED" ] \
  || { echo "$NODE_ZIP doesn't match its SHA-256 in SHASUMS256.txt"; rm -f "$CACHE/$NODE_ZIP"; exit 1; }

echo "Building Watchlist $VERSION for Windows $ARCH with Node $NODE_VERSION…"
STAGE="$OUT/build-win"
APP="$STAGE/Watchlist"
rm -rf "$STAGE"
mkdir -p "$APP/node" "$APP/app" "$STAGE/unzip"

unzip -q "$CACHE/$NODE_ZIP" "node-$NODE_VERSION-win-$ARCH/node.exe" "node-$NODE_VERSION-win-$ARCH/LICENSE" -d "$STAGE/unzip"
mv "$STAGE/unzip/node-$NODE_VERSION-win-$ARCH/node.exe" "$STAGE/unzip/node-$NODE_VERSION-win-$ARCH/LICENSE" "$APP/node/"
rm -rf "$STAGE/unzip"
file "$APP/node/node.exe" | grep -q "PE32+ executable.*$PE" || { echo "node.exe isn't a $ARCH Windows program"; exit 1; }

# Only what the server needs: this leaves out .env, data/, .claude-tests/, .git, docs and the Mac tools.
rsync -a --exclude '.DS_Store' \
  "$ROOT/server.js" "$ROOT/package.json" "$ROOT/package-lock.json" "$ROOT/lib" "$ROOT/public" "$ROOT/node_modules" \
  "$APP/app/"
# Drop any dev-only packages (offline; nothing is fetched), and the .bin links, which Windows doesn't need.
(cd "$APP/app" && npm prune --omit=dev --offline --no-audit --no-fund --silent)
find "$APP/app/node_modules" -name .bin -prune -exec rm -rf {} +
if [ -n "$(find "$APP" -type l)" ]; then echo "Symlinks left in the app folder:"; find "$APP" -type l; exit 1; fi
# node_modules is copied from this Mac, so it must not contain native add-ons.
if [ -n "$(find "$APP/app/node_modules" -name '*.node')" ]; then
  echo "node_modules has native add-ons, which won't run on Windows:"; find "$APP/app/node_modules" -name '*.node'; exit 1
fi

# Tray app: icon and version info go in a .syso resource that go build picks up.
swift "$HERE/icon.swift" "$HERE/icon.ico"
(
  cd "$HERE"
  rm -f rsrc_windows_*.syso
  go tool go-winres simply --arch "$GOARCH" --out rsrc --manifest gui --icon icon.ico \
    --product-name Watchlist --file-description Watchlist --original-filename Watchlist.exe \
    --product-version "$VERSION" --file-version "$VERSION"
  GOOS=windows GOARCH="$GOARCH" go vet ./...
  GOOS=windows GOARCH="$GOARCH" CGO_ENABLED=0 go build -trimpath -ldflags "-H windowsgui" -o "$APP/Watchlist.exe" .
  rm -f rsrc_windows_*.syso
)
file "$APP/Watchlist.exe" | grep -q "PE32+ executable (GUI) $PE" || { echo "Watchlist.exe isn't a $ARCH Windows GUI program"; exit 1; }

echo "Making zip…"
ZIP="$OUT/Watchlist-$VERSION-win-$ARCH.zip"
rm -f "$ZIP"
(cd "$STAGE" && zip -qrX "$ZIP" Watchlist)
rm -rf "$STAGE"

echo "Done:"
echo "  $ZIP ($(du -h "$ZIP" | cut -f1))"
