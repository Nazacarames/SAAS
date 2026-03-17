#!/usr/bin/env bash
set -euo pipefail

echo "[stage-check] A: canary auth/users"
curl -s -o /dev/null -w '%{http_code}\n' https://login.charlott.ai/api/auth/me
curl -s -o /dev/null -w '%{http_code}\n' -H 'x-api-canary: 1' https://login.charlott.ai/api/auth/me

echo "[stage-check] B: reads"
curl -s -o /dev/null -w '%{http_code}\n' https://login.charlott.ai/api/contacts
curl -s -o /dev/null -w '%{http_code}\n' https://login.charlott.ai/api/conversations

echo "[stage-check] done"
