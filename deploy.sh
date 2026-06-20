#!/bin/bash
set -euo pipefail

APP_DIR="/home/deploy/atendechat"
FRONTEND_DIR="$APP_DIR/frontend"
BACKEND_DIR="$APP_DIR/services/backend-fastapi"
WEB_DIR="/var/www/atendechat"

echo "=== LMTM CRM Deploy ==="
echo "$(date)"

# 1. Pull latest (if git remote exists)
cd "$APP_DIR"
if git remote -v 2>/dev/null | grep -q origin; then
    echo "[1/5] Pulling latest changes..."
    git pull origin main --ff-only || { echo "WARN: git pull failed, continuing with local"; }
else
    echo "[1/5] No remote configured, using local files"
fi

# 2. Backend dependencies
echo "[2/5] Checking backend dependencies..."
cd "$BACKEND_DIR"
if [ -f requirements.txt ]; then
    .venv/bin/pip install -r requirements.txt -q 2>/dev/null || true
fi

# 3. Frontend build
echo "[3/5] Building frontend..."
cd "$FRONTEND_DIR"
npm ci --silent 2>/dev/null || npm install --silent
npm run build

# 4. Deploy frontend
echo "[4/5] Deploying frontend..."
rm -rf "$WEB_DIR"/*
cp -r "$FRONTEND_DIR/build/"* "$WEB_DIR/"

# 5. Restart services
echo "[5/5] Restarting services..."
systemctl restart charlott-fastapi
sleep 2
systemctl reload nginx

# Verify
if systemctl is-active --quiet charlott-fastapi; then
    echo ""
    echo "=== Deploy OK ==="
    HEALTH=$(curl -sf http://localhost:4010/health/deep 2>/dev/null || echo {status:unknown})
    echo "Health: $HEALTH"
else
    echo ""
    echo "=== Deploy FAILED ==="
    journalctl -u charlott-fastapi --no-pager -n 20
    exit 1
fi
