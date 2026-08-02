#!/bin/sh
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a

FAILED=0
for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 2213278747143677 3035560362970447 2286455750996728; do
  /opt/homebrew/bin/node scripts/fetch-bid-recommendations.mjs \
    --profile "${P}" || { echo "PROFILE ${P} bid-recs FAILED"; FAILED=1; }
  echo "=== sync-targeting profile ${P} ==="
  /opt/homebrew/bin/node scripts/sync-targeting.mjs --profile "${P}" \
    && echo "=== generate-recommendations profile ${P} ===" \
    && /opt/homebrew/bin/node scripts/generate-recommendations.mjs --profile "${P}" \
    || { echo "PROFILE ${P} FAILED"; FAILED=1; }
done

exit ${FAILED}
