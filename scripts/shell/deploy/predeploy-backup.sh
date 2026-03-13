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

# Database backup before deploy
echo "Creating database backup..."
if command -v pg_dump &>/dev/null; then
    SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
    if [ -f "$SCRIPT_DIR/backup-db.sh" ]; then
        bash "$SCRIPT_DIR/backup-db.sh" || echo "Warning: Database backup failed, continuing..."
    else
        echo "Warning: backup-db.sh not found, skipping database backup"
    fi
else
    echo "Warning: pg_dump not found, skipping database backup"
fi

echo "BACKUP_OK $OUT"
