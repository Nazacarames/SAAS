#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/deploy/atendechat/services/backend-fastapi"
SERVICE_SRC="$APP_DIR/deploy/charlott-fastapi.service"
SERVICE_DST="/etc/systemd/system/charlott-fastapi.service"

cd "$APP_DIR"
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -e .

cp "$SERVICE_SRC" "$SERVICE_DST"
systemctl daemon-reload
systemctl enable charlott-fastapi
systemctl restart charlott-fastapi

systemctl status charlott-fastapi --no-pager -l | sed -n '1,40p'
curl -fsS http://127.0.0.1:4010/health

echo "[fastapi] service ready on 127.0.0.1:4010"
