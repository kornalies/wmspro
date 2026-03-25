#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <git-ref>"
  echo "Example: $0 v1.3.2"
  exit 1
fi

GIT_REF="$1"
APP_DIR="/opt/wmspro/current"

cd "$APP_DIR"
echo "[1/7] Fetching code..."
git fetch --all --tags

echo "[2/7] Checking out ${GIT_REF}..."
git checkout "$GIT_REF"

echo "[3/7] Installing dependencies..."
npm ci

echo "[4/7] Loading env..."
set -a
source .env.production
set +a

echo "[5/7] Running migrations..."
npm run db:migrate

echo "[6/7] Building production bundle..."
npx next build

echo "[7/7] Restarting service..."
sudo systemctl restart wmspro
sudo systemctl status wmspro --no-pager

echo "Verifying health endpoint..."
curl -fsS http://127.0.0.1:3000/api/health
echo
echo "Release complete."

