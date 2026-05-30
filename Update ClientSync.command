#!/bin/bash
# Double-click this file to download and install the latest ClientSync extension.
set -e

URL="https://github.com/XtreamAnkit/clientsync/releases/latest/download/clientsync.zip"
DEST="$HOME/clientsync-extension"

echo "Updating ClientSync..."
rm -rf "$DEST"
mkdir -p "$DEST"
curl -fSL "$URL" -o /tmp/cs.zip
unzip -oq /tmp/cs.zip -d "$DEST"
rm -f /tmp/cs.zip

echo ""
echo "Done. Files are in: $DEST"
echo ""
echo "Next (one time only): open chrome://extensions, turn on Developer mode,"
echo "click 'Load unpacked', and select the clientsync-extension folder in your home directory."
echo ""
echo "After every update: go to chrome://extensions, click the reload icon on"
echo "ClientSync, then refresh your Zendesk tab."
echo ""
echo "You can close this window."
