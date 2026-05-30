#!/bin/bash
# Release a new version of ClientSync.
#   ./release.sh "message"            -> patch bump (1.3.0 -> 1.3.1)
#   ./release.sh patch "message"      -> 1.3.0 -> 1.3.1
#   ./release.sh minor "message"      -> 1.3.0 -> 1.4.0
#   ./release.sh major "message"      -> 1.3.0 -> 2.0.0
set -e
cd "$(dirname "$0")"

REPO="XtreamAnkit/clientsync"

# Parse args: first arg may be a bump type; otherwise default to patch.
case "$1" in
  patch|minor|major) BUMP="$1"; MSG="$2" ;;
  *)                 BUMP="patch"; MSG="$1" ;;
esac
[ -z "$MSG" ] && MSG="Maintenance release"

# Read current version from manifest.json
CUR=$(grep '"version"' manifest.json | head -1 | sed -E 's/.*"version": *"([0-9.]+)".*/\1/')
IFS='.' read -r MA MI PA <<< "$CUR"

case "$BUMP" in
  patch) PA=$((PA+1)) ;;
  minor) MI=$((MI+1)); PA=0 ;;
  major) MA=$((MA+1)); MI=0; PA=0 ;;
esac
NEW="$MA.$MI.$PA"

echo "Releasing $CUR -> $NEW  ($BUMP)"

# Write the new version back into manifest.json
sed -i '' -E "s/(\"version\": *\")$CUR(\")/\1$NEW\2/" manifest.json

# Commit, push, zip, publish
git add -A
git commit -q -m "v$NEW: $MSG"
git push -q
rm -f ~/clientsync.zip
zip -rq ~/clientsync.zip . -x ".*" -x "*.DS_Store" -x "*.git*"
gh release create "v$NEW" ~/clientsync.zip --repo "$REPO" --title "v$NEW" --notes "$MSG"

echo "Published v$NEW. Teammates below v$NEW will now see the update banner."
