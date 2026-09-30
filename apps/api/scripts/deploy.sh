#!/bin/sh
# Builds the web app and deploys the Worker with the commit it was built from, so /version can be matched to git.
set -e
cd "$(dirname "$0")/.."
commit=$(git rev-parse --short HEAD)
if [ -n "$(git status --porcelain -- . ../../packages ../web/src)" ]; then commit="$commit-dirty"; fi
pnpm --filter @intyr/web build
exec wrangler deploy --var "GIT_COMMIT:$commit"
