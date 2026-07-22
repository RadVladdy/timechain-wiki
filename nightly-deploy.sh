#!/bin/bash
# TimechainWiki nightly rebuild+deploy: re-syncs the Bitcoin KB into the live
# site (leak-guard fails the build on any internal-content leak, so a bad sync
# can never ship). Deploys ONLY if the build succeeds.
set -e
cd "$HOME/dev/timechain-wiki-astro"
npm run build
CLOUDFLARE_API_TOKEN=$(cat "$HOME/secure/cloudflare-pages-token") npx wrangler pages deploy dist --project-name=timechain-wiki --commit-dirty=true
echo "[$(date -Is)] nightly deploy OK"
