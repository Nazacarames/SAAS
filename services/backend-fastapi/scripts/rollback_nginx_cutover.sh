#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: $0 <backup-file>"
  exit 1
fi

BACKUP_FILE="$1"
SITE_FILE="/etc/nginx/sites-enabled/charlott-frontend"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "backup not found: $BACKUP_FILE"
  exit 1
fi

cp "$BACKUP_FILE" "$SITE_FILE"
nginx -t
systemctl reload nginx

echo "[cutover] rollback applied: $BACKUP_FILE"
