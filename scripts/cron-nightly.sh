#!/bin/sh
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a

# Retry-slot guard: if all 9 profiles have max(landed_at) > today 02:00, skip.
if /opt/homebrew/bin/node scripts/nightly-guard.mjs 2>/dev/null; then
  echo "retry slot: nothing to do"
  exit 0
fi

for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 2213278747143677 3035560362970447 2286455750996728; do
  echo "=== nightly-sync profile ${P} ==="
  /opt/homebrew/bin/node --max-old-space-size=2048 scripts/nightly-sync.mjs --profile "${P}" || echo "PROFILE ${P} nightly-sync FAILED (non-fatal)"
done

for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 2213278747143677 3035560362970447 2286455750996728; do
  echo "=== sync-campaigns profile ${P} ==="
  /opt/homebrew/bin/node scripts/sync-campaigns.mjs --profile "${P}" || echo "PROFILE ${P} sync-campaigns FAILED (non-fatal)"
done

echo "=== reject-stale-recommendations ==="
/opt/homebrew/bin/node scripts/reject-stale-recommendations.mjs || echo "reject-stale-recommendations FAILED (non-fatal)"

for P in 2263723137827296 139446882235960 395707988492653 350599867165328 1711934819800765 2213278747143677 3035560362970447 2286455750996728; do
  echo "=== stamp-outcomes profile ${P} ==="
  /opt/homebrew/bin/node scripts/stamp-outcomes.mjs --profile "${P}" || echo "PROFILE ${P} stamp-outcomes FAILED (non-fatal)"
done

echo "=== rollup-daily (--days 3) ==="
/opt/homebrew/bin/node scripts/rollup-daily.mjs --days 3 || echo "rollup-daily FAILED (non-fatal)"

exit 0
