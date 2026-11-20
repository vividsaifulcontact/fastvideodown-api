#!/bin/bash
# Build-time: fetch a static ffmpeg binary (needed to MERGE video+audio for
# 1080p+ with sound — YouTube ships no pre-merged 1080p file). Uses the
# johnvansickle.com static build (ffmpeg + ffprobe). Skips the download if
# ./bin/ffmpeg already exists and is executable.
set -e
URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/bin"
if [ -x "$ROOT/bin/ffmpeg" ]; then
  echo "ffmpeg already present at $ROOT/bin/ffmpeg — skipping download."
  exit 0
fi
TMPDIR_FF="$(mktemp -d)"
echo "Downloading static ffmpeg ..."
curl -L --fail -o "$TMPDIR_FF/ffmpeg.tar.xz" "$URL"
tar -xf "$TMPDIR_FF/ffmpeg.tar.xz" -C "$TMPDIR_FF"
FFBIN="$(find "$TMPDIR_FF" -name ffmpeg -type f | head -1)"
FPBIN="$(find "$TMPDIR_FF" -name ffprobe -type f | head -1)"
cp "$FFBIN" "$ROOT/bin/ffmpeg"
chmod +x "$ROOT/bin/ffmpeg"
if [ -n "$FPBIN" ]; then cp "$FPBIN" "$ROOT/bin/ffprobe"; chmod +x "$ROOT/bin/ffprobe"; fi
rm -rf "$TMPDIR_FF"
echo "ffmpeg ready at $ROOT/bin/ffmpeg"
"$ROOT/bin/ffmpeg" -version | head -1
