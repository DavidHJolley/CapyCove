#!/usr/bin/env bash
# Build the client locally and ship the game to the Google Cloud server.
# Needs the "capycove" host alias in ~/.ssh/config (or set CAPY_HOST).
# Player data on the server (data/) is never touched, except data/calendar.json,
# which is tracked source.
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${CAPY_HOST:-capycove}"

npm run build
tar czf - dist server shared scripts package.json package-lock.json data/calendar.json \
  | ssh "$HOST" 'mkdir -p ~/capycove && cd ~/capycove && rm -rf dist && tar xzf - && npm ci --omit=dev --no-audit --no-fund'
ssh "$HOST" 'sudo systemctl restart capycove && sleep 3 && systemctl is-active capycove && curl -fsS -o /dev/null -w "health %{http_code}\n" localhost:3001/api/health'
