#!/bin/sh
# Build the containers with this commit baked in.
#
#   ./build.sh              everything
#   ./build.sh talents      just one service
#
# The images cannot see .git - .dockerignore excludes it - so the commit has to
# be handed to them. Running `docker compose build` directly still works; the
# footer just says "dev", which is honest rather than wrong.
set -e
cd "$(dirname "$0")"

GIT_SHA=$(git rev-parse --short=7 HEAD 2>/dev/null || echo "")
GIT_DATE=$(git log -1 --format=%cs 2>/dev/null || echo "")
GIT_DIRTY=$([ -n "$(git status --porcelain 2>/dev/null)" ] && echo 1 || echo 0)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export GIT_SHA GIT_DATE GIT_DIRTY BUILD_TIME

echo "building ${GIT_SHA:-dev}${GIT_DATE:+ ($GIT_DATE)}"
[ "$GIT_DIRTY" = "1" ] && echo "  note: uncommitted changes, so this is not exactly $GIT_SHA"

docker compose up -d --build "$@"
