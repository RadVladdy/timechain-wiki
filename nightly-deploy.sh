#!/bin/bash
# TimechainWiki nightly rebuild+deploy (cron 04:25): re-syncs the Bitcoin KB into
# the live site. The build's leak-guard fails on any internal-content leak, so a
# bad sync can never ship. Deploys ONLY if the build succeeds.
#
# The deploy itself is delegated to scripts/deploy.sh — the same script
# `npm run deploy` runs — so the automated path and the manual path can never
# drift into two different implementations with two different token handlers.
set -e
cd "$HOME/dev/timechain-wiki-astro"
npm run build
bash scripts/deploy.sh
echo "[$(date -Is)] nightly deploy OK"
