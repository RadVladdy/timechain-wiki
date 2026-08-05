#!/usr/bin/env bash
# Deploy timechain.wiki to Cloudflare. Run via: npm run deploy
#
# ONE PATTERN across every site repo. Same command name, same token handling,
# same shape, so there is one thing to fix rather than four. Exactly two things
# differ per repo and both are named right here:
#
#   TARGET      — a Worker (wrangler deploy) or a Pages direct upload
#   TOKEN_FILE  — the credential that target type actually accepts
#
# WHY THE TOKEN FILE IS NOT THE SAME EVERYWHERE. A Pages-scoped token cannot
# deploy a Worker — wrangler fails with `Authentication error [code: 10000]` —
# and the two token files here are scoped differently. Copying another repo's
# line without checking what this repo deploys to is a real bug that shipped
# once already, and it stayed invisible because every deploy happened to run
# with a working token already in the environment, so the fallback below was
# never the path that ran. If this file is ever edited, test it the way it is
# actually broken: run with CLOUDFLARE_API_TOKEN explicitly unset.
#
# This site is a PAGES DIRECT UPLOAD (project `timechain-wiki`), so the
# Pages-scoped token is the correct one.
#
# THIS SITE HAS A SANCTIONED NIGHTLY DEPLOY, which is a deliberate exception to
# "deploying is always a manual act": its content is generated from the Bitcoin
# KB, so it must be able to go live without a person. `nightly-deploy.sh` (cron
# 04:25) rebuilds and then calls THIS script, so the automated path and the
# manual path are the same code — the build's leak-guard fails the build on any
# internal-content leak, so a bad sync can never ship. Do not let the two paths
# drift into separate implementations.
set -euo pipefail
cd "$(dirname "$0")/.."

TOKEN_FILE="$HOME/secure/cloudflare-pages-token"

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  if [ -f "$TOKEN_FILE" ]; then
    CLOUDFLARE_API_TOKEN="$(tr -d '\n\r ' < "$TOKEN_FILE")"
    export CLOUDFLARE_API_TOKEN
  else
    echo "ERROR: set CLOUDFLARE_API_TOKEN or provide $TOKEN_FILE" >&2
    exit 1
  fi
fi

npx wrangler pages deploy dist --project-name=timechain-wiki --commit-dirty=true

echo "── deployed. Verify on the live domain before calling it done."
