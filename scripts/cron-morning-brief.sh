#!/bin/sh
export PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd /Users/christianhultner/cdl-ads || exit 1
set -a
. ./.env.local
. /Users/christianhultner/secrets/cdl-ads-lwa.env
set +a

/opt/homebrew/bin/node scripts/morning-brief.mjs
