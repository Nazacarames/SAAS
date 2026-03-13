#!/usr/bin/env bash
# Automated PostgreSQL backup script
# Add to crontab: 0 3 * * * /path/to/backup-db.sh >> /var/log/db-backup.log 2>&1

set -euo pipefail

# Configuration (override via environment)
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-atendechat}"
DB_USER="${DB_USER:-atendechat_user}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/atendechat}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Generate filename with timestamp
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

echo "[$(date -Iseconds)] Starting backup of $DB_NAME..."

# Run pg_dump with compression
PGPASSWORD="${DB_PASS:-}" pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -d "$DB_NAME" \
    --no-owner \
    --no-privileges \
    --format=custom \
    --compress=6 \
    -f "$BACKUP_FILE"

# Verify backup file exists and has content
if [ -s "$BACKUP_FILE" ]; then
    SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
    echo "[$(date -Iseconds)] Backup successful: $BACKUP_FILE ($SIZE)"
else
    echo "[$(date -Iseconds)] ERROR: Backup file is empty or missing!"
    exit 1
fi

# Cleanup old backups
if [ "$RETENTION_DAYS" -gt 0 ]; then
    DELETED=$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
    echo "[$(date -Iseconds)] Cleaned up $DELETED backup(s) older than $RETENTION_DAYS days"
fi

echo "[$(date -Iseconds)] Backup complete"
