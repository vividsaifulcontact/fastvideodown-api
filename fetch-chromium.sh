#!/bin/bash
# Install Playwright Chromium for headless browser automation (dlsrv/Cap check).
# Skips if the chromium binary is already present.
set -e
if [ -x "./ms-playwright/chromium/chrome-linux/chrome" ]; then
  echo "chromium already present, skipping"
  exit 0
fi
echo "installing playwright chromium (this downloads ~150MB)..."
npx -y playwright@latest install chromium --with-deps 2>&1 | tail -5 || npx -y playwright@latest install chromium 2>&1 | tail -5
echo "chromium install done"
ls -la ./ms-playwright/chromium/ 2>/dev/null | head -5
