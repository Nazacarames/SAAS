# Canary Execution Runbook (VPS)

## Preconditions
- Repo updated in `/home/deploy/atendechat` with latest FastAPI files.
- FastAPI service running on `127.0.0.1:4010`.
- Node service running on `127.0.0.1:4000`.

## 1) Provision FastAPI service (systemd)

```bash
cd /home/deploy/atendechat
chmod +x services/backend-fastapi/deploy/setup_fastapi_service.sh
sudo bash services/backend-fastapi/deploy/setup_fastapi_service.sh
```

## 2) Install cutover config + scripts

```bash
cd /home/deploy/atendechat
chmod +x services/backend-fastapi/scripts/apply_nginx_cutover.sh
chmod +x services/backend-fastapi/scripts/rollback_nginx_cutover.sh
cp services/backend-fastapi/nginx.charlott-frontend.cutover.conf \
  /home/deploy/atendechat/services/backend-fastapi/nginx.charlott-frontend.cutover.conf
```

## 3) Apply cutover safely

```bash
sudo bash /home/deploy/atendechat/services/backend-fastapi/scripts/apply_nginx_cutover.sh
```

Expected output includes:
- `[cutover] applied ok`
- backup path: `/home/deploy/deploy-backups/nginx/charlott-frontend.YYYYMMDD-HHMMSS.bak`

## 4) Canary checks (header controlled)

### 3.1 Node path default (without header)
```bash
curl -i https://login.charlott.ai/api/auth/me
```

### 3.2 FastAPI canary path (with header)
```bash
curl -i -H 'x-api-canary: 1' https://login.charlott.ai/api/auth/me
```

### 3.3 Users canary
```bash
curl -i -H 'x-api-canary: 1' https://login.charlott.ai/api/users/
```

### 3.4 Optional one-shot verifier
```bash
bash /home/deploy/atendechat/services/backend-fastapi/deploy/verify_fastapi_canary.sh
```

## 5) Rollback (if needed)

```bash
sudo bash /home/deploy/atendechat/services/backend-fastapi/scripts/rollback_nginx_cutover.sh \
  /home/deploy/deploy-backups/nginx/charlott-frontend.<STAMP>.bak
```

## 6) Promotion sequence
1. Keep stage-1 canary 30-60 min.
2. Monitor 401/403/5xx and p95.
3. Promote read routes to FastAPI.
4. Promote write routes.
5. Keep webhook+socket on Node until parity sign-off.

## 7) One-shot Stage A command

```bash
cd /home/deploy/atendechat
chmod +x services/backend-fastapi/deploy/ONE_SHOT_STAGE_A.sh
bash services/backend-fastapi/deploy/ONE_SHOT_STAGE_A.sh
```

## 8) Promote to Stage B (reads to FastAPI)

```bash
cd /home/deploy/atendechat
cp services/backend-fastapi/nginx.charlott-frontend.stage-b.conf /etc/nginx/sites-enabled/charlott-frontend
nginx -t && systemctl reload nginx
```

### Rollback Stage B → A
```bash
cp services/backend-fastapi/nginx.charlott-frontend.cutover.conf /etc/nginx/sites-enabled/charlott-frontend
nginx -t && systemctl reload nginx
```

## 9) Promote to Stage C (all routes to FastAPI)

```bash
cd /home/deploy/atendechat
cp services/backend-fastapi/nginx.charlott-frontend.stage-c.conf /etc/nginx/sites-enabled/charlott-frontend
nginx -t && systemctl reload nginx
```

### Rollback Stage C → B
```bash
cp services/backend-fastapi/nginx.charlott-frontend.stage-b.conf /etc/nginx/sites-enabled/charlott-frontend
nginx -t && systemctl reload nginx
```
