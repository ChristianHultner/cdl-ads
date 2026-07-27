#!/bin/sh
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a
exec /opt/homebrew/bin/node scripts/nightly-sync.mjs --profile 2263723137827296
