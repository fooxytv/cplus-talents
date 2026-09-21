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

echo "==> done: $(git log --oneline -1)"
