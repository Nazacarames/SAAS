#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/deploy/atendechat"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="${ROOT}/backups/predeploy-${STAMP}.tgz"

mkdir -p "${ROOT}/backups"

tar -czf "$OUT" \
  -C "$ROOT" \
  backend/src backend/package.json backend/package-lock.json backend/ecosystem.config.cjs \
  frontend/src frontend/package.json frontend/package-lock.json frontend/vite.config.ts

echo "BACKUP_OK $OUT"
