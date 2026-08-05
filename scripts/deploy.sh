#!/usr/bin/env bash
# Deploy timechain.wiki to Cloudflare. Run via: npm run deploy
#
# ONE PATTERN across every site repo. Same command name, same token, same file,
# so there is one thing to fix rather than four. Only the deploy command itself
# differs, according to what this site IS — here, a Pages direct upload to the
# project `timechain-wiki`.
#
# THE TOKEN IS THE SAME IN ALL FOUR REPOS and that is deliberate. Until
# 2026-08-05 there were two half-scoped Cloudflare tokens, one that could deploy
# Pages and one that could deploy Workers, so the correct credential depended on
# what a repo shipped to. Copying a sibling repo's token line then produced a
# deploy that could never authenticate (`Authentication error [code: 10000]`) —
# and it stayed invisible because every deploy happened to run with a working
# token already exported in the environment, so the fallback below was never once
# the path that actually ran. One token with both scopes removes the whole class.
#
# If this file is ever edited, test it the way it actually breaks: run it with
# CLOUDFLARE_API_TOKEN explicitly unset, so the fallback IS the path that runs.
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

TOKEN_FILE="$HOME/secure/cloudflare-deploy-token"

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
