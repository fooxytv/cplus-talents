#!/bin/sh
# Pull the latest code and restart the public site.
#
#   ./deploy/update.sh
#
# --ff-only so a diverged checkout stops rather than quietly merging. .env is
# gitignored, so it is never touched by the pull.
set -e
cd "$(dirname "$0")/.."

echo "==> pulling"
git pull --ff-only origin main

# The image cannot see .git - .dockerignore excludes it - so the commit is
# passed in. Without this the footer would read "dev" and a deploy that had not
# actually taken would be indistinguishable from one that had.
GIT_SHA=$(git rev-parse --short=7 HEAD)
GIT_DATE=$(git log -1 --format=%cs)
GIT_DIRTY=$([ -n "$(git status --porcelain)" ] && echo 1 || echo 0)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
export GIT_SHA GIT_DATE GIT_DIRTY BUILD_TIME
echo "    building $GIT_SHA ($GIT_DATE)"
[ "$GIT_DIRTY" = "1" ] && echo "    NOTE: the checkout has uncommitted changes"

echo "==> rebuilding"
cd deploy
docker compose --profile tunnel up -d --build

echo "==> waiting for the container to report healthy"
for i in $(seq 1 30); do
  status=$(docker inspect --format '{{.State.Health.Status}}' \
    "$(docker compose ps -q talents)" 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && break
  sleep 2
done
echo "    $status"

echo "==> checking the guards are still on"
curl -fsS localhost:"${PORT:-5502}"/api/config | grep -q '"editMode":false' \
  && echo "    editMode is false for an anonymous request - good" \
  || { echo "    WARNING: edit mode is open to anonymous visitors, check ADMIN_KEY"; exit 1; }

# The point of versioning: prove the running site is the commit just pulled,
# rather than an older image that happened to still be there.
echo "==> checking the running site is this commit"
running=$(curl -fsS localhost:"${PORT:-5502}"/api/version | sed -n 's/.*"sha":"\([^"]*\)".*/\1/p')
if [ "$running" = "$GIT_SHA" ]; then
  echo "    serving $running - matches"
else
  echo "    WARNING: pulled $GIT_SHA but the site reports '$running'"
  echo "    the rebuild did not take; try: docker compose up -d --build --force-recreate"
  exit 1
fi

echo "==> done: $(git log --oneline -1)"
