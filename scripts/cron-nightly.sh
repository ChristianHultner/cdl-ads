#!/bin/sh
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a

FAILED=0
for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 1068790837798301 2213278747143677 3035560362970447 2286455750996728; do
  echo "=== nightly-sync profile ${P} ==="
  /opt/homebrew/bin/node scripts/nightly-sync.mjs --profile "${P}" || { echo "PROFILE ${P} FAILED"; FAILED=1; }
done

for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 1068790837798301 2213278747143677 3035560362970447 2286455750996728; do
  echo "=== sync-campaigns profile ${P} ==="
  /opt/homebrew/bin/node scripts/sync-campaigns.mjs --profile "${P}" || { echo "PROFILE ${P} sync-campaigns FAILED"; FAILED=1; }
done

for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 1068790837798301 2213278747143677 3035560362970447 2286455750996728; do
  echo "=== stamp-outcomes profile ${P} ==="
  /opt/homebrew/bin/node scripts/stamp-outcomes.mjs --profile "${P}" || { echo "PROFILE ${P} stamp-outcomes FAILED"; FAILED=1; }
done

exit ${FAILED}
