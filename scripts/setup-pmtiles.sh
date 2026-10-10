#!/bin/sh
# Download the go-pmtiles CLI for local dev (POST /export-pmtiles shells out
# to it for the MBTiles -> PMTiles conversion). Production gets it via Dockerfile.
# Usage: sh scripts/setup-pmtiles.sh
set -eu
VERSION=1.31.2
OUT="api/bin/pmtiles"
if [ -x "$OUT" ]; then
  echo "pmtiles already present at $OUT"
  exit 0
fi
OS=$(uname -s)
ARCH=$(uname -m)
case "$OS-$ARCH" in
  Darwin-arm64) ASSET="go-pmtiles-${VERSION}_Darwin_arm64.zip" ;;
  Darwin-x86_64) ASSET="go-pmtiles-${VERSION}_Darwin_x86_64.zip" ;;
  Linux-x86_64) ASSET="go-pmtiles_${VERSION}_Linux_x86_64.tar.gz" ;;
  Linux-aarch64|Linux-arm64) ASSET="go-pmtiles_${VERSION}_Linux_arm64.tar.gz" ;;
  *) echo "Unsupported platform $OS-$ARCH — set PMTILES_BIN manually" >&2; exit 1 ;;
esac
mkdir -p api/bin
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/pkg" "https://github.com/protomaps/go-pmtiles/releases/download/v${VERSION}/${ASSET}"
case "$ASSET" in
  *.zip) unzip -o -j "$TMP/pkg" -d api/bin ;;
  *.tar.gz) tar -xzf "$TMP/pkg" -C "$TMP" && mv "$TMP/pmtiles" api/bin/pmtiles ;;
esac
chmod +x api/bin/pmtiles
echo "Installed $OUT"
