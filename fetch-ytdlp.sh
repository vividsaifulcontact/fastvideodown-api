#!/bin/bash
# Build-time: fetch the standalone yt-dlp binary (the repo does not store the
# 41MB binary; Render downloads it fresh on every deploy).
# Skips the download if ./yt-dlp already exists and is executable.
set -e
VER="2026.10.26"
URL="https://github.com/yt-dlp/yt-dlp/releases/download/${VER}/yt-dlp_linux"
ROOT="$(cd "$(dirname "$0")" && pwd)"
if [ -x "$ROOT/yt-dlp" ]; then
  echo "yt-dlp already present at $ROOT/yt-dlp — skipping download."
  exit 0
fi
TMPBIN="$(mktemp)"
echo "Downloading yt-dlp ${VER} ..."
curl -L --fail -o "$TMPBIN" "$URL"
chmod +x "$TMPBIN"
cp "$TMPBIN" "$ROOT/yt-dlp"
chmod +x "$ROOT/yt-dlp"
rm -f "$TMPBIN"
echo "yt-dlp ready at $ROOT/yt-dlp"
