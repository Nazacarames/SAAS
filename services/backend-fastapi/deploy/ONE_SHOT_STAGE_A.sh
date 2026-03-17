#!/usr/bin/env bash
set -euo pipefail

ROOT="/home/deploy/atendechat"

cd "$ROOT"

# 1) Provision FastAPI service
chmod +x services/backend-fastapi/deploy/setup_fastapi_service.sh
sudo bash services/backend-fastapi/deploy/setup_fastapi_service.sh

# 2) Ensure cutover scripts executable
chmod +x services/backend-fastapi/scripts/apply_nginx_cutover.sh
chmod +x services/backend-fastapi/scripts/rollback_nginx_cutover.sh
chmod +x services/backend-fastapi/deploy/verify_fastapi_canary.sh
chmod +x services/backend-fastapi/deploy/promote_stage_checklist.sh

# 3) Apply nginx cutover safely (canary-ready)
sudo bash services/backend-fastapi/scripts/apply_nginx_cutover.sh

# 4) Verify canary behavior
bash services/backend-fastapi/deploy/verify_fastapi_canary.sh
bash services/backend-fastapi/deploy/promote_stage_checklist.sh

echo "[one-shot] Stage A ready"
