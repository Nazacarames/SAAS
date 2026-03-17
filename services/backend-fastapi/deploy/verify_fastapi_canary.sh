#!/usr/bin/env bash
set -euo pipefail

echo "[1] health local"
curl -i -s http://127.0.0.1:4010/health | head -n 20

echo "[2] login.charlott.ai default path (node/fallback)"
curl -i -s https://login.charlott.ai/api/auth/me | head -n 20

echo "[3] login.charlott.ai canary path (fastapi header)"
curl -i -s -H 'x-api-canary: 1' https://login.charlott.ai/api/auth/me | head -n 20

echo "[verify] done"
