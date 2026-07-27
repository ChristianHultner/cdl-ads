#!/bin/sh
set -e
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a

for PROFILE in 2263723137827296 139446882235960; do
  echo "=== sync-targeting profile ${PROFILE} ==="
  /opt/homebrew/bin/node scripts/sync-targeting.mjs --profile "${PROFILE}"
  echo "=== generate-recommendations profile ${PROFILE} ==="
  /opt/homebrew/bin/node scripts/generate-recommendations.mjs --profile "${PROFILE}"
done
