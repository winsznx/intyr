#!/bin/sh
# Renders og/card.html to public/og.png at 1200x630 with headless Chrome. Set CHROME to point at another Chrome binary.
set -e
cd "$(dirname "$0")"
chrome=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
"$chrome" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --allow-file-access-from-files \
  --virtual-time-budget=4000 --window-size=1200,630 --screenshot="$PWD/../public/og.png" "file://$PWD/card.html"
