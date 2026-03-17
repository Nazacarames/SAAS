#!/usr/bin/env bash
set -euo pipefail

SITE_FILE="/etc/nginx/sites-enabled/charlott-frontend"
CUTOVER_FILE="/home/deploy/atendechat/services/backend-fastapi/nginx.charlott-frontend.cutover.conf"
BACKUP_DIR="/home/deploy/deploy-backups/nginx"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/charlott-frontend.${STAMP}.bak"

mkdir -p "$BACKUP_DIR"
cp "$SITE_FILE" "$BACKUP_FILE"
cp "$CUTOVER_FILE" "$SITE_FILE"

if ! nginx -t; then
  echo "[cutover] nginx -t failed, restoring backup..."
  cp "$BACKUP_FILE" "$SITE_FILE"
  nginx -t
  exit 1
fi

systemctl reload nginx
echo "[cutover] applied ok"
echo "[cutover] backup: $BACKUP_FILE"
