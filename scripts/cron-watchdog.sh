#!/bin/sh
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a

/opt/homebrew/bin/node scripts/watchdog.mjs
