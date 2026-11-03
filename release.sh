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

echo "Published v$NEW."

# ─── Point the backend at this release ────────────────────────────────────────
# Sets latest_version AND min_version to $NEW (every release is mandatory), and
# repoints the download to the new GitHub asset. The admin secret is read from a
# local file / env var so it NEVER lands in this public repo or the shipped zip.
TELEMETRY="https://zdrvlyudicqxavzpiwjv.supabase.co/functions/v1/telemetry"
ADMIN_SECRET="${CLIENTSYNC_ADMIN_SECRET:-$(cat "$HOME/.clientsync_admin" 2>/dev/null)}"
if [ -z "$ADMIN_SECRET" ]; then
  echo "NOTE: no admin secret found — backend not updated automatically."
  echo "      Set it once:  echo 'YOUR_ADMIN_PASSWORD' > ~/.clientsync_admin && chmod 600 ~/.clientsync_admin"
  echo "      Until then, set latest_version/min_version to $NEW in the admin panel."
else
  ASSET_ID=$(gh api "repos/$REPO/releases/tags/v$NEW" --jq '.assets[] | select(.name=="clientsync.zip") | .id' 2>/dev/null)
  ZIP_URL="https://api.github.com/repos/$REPO/releases/assets/$ASSET_ID"
  HTTP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$TELEMETRY" \
    -H "x-admin-secret: $ADMIN_SECRET" -H "Content-Type: application/json" \
    -d "{\"type\":\"config_update\",\"latest_version\":\"$NEW\",\"min_version\":\"$NEW\",\"github_zip_url\":\"$ZIP_URL\"}")
  if [ "$HTTP" = "200" ] || [ "$HTTP" = "204" ]; then
    echo "Backend updated: latest_version=min_version=$NEW, download → asset $ASSET_ID."
  else
    echo "WARN: backend config update failed (HTTP $HTTP) — set latest_version/min_version to $NEW in the admin panel."
  fi
fi

echo "Done. Every agent below v$NEW now sees a REQUIRED update."
