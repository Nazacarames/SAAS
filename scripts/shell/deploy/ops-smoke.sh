#!/usr/bin/env bash
set -euo pipefail

BASE_WEB="${BASE_WEB:-https://login.charlott.ai}"
BASE_API="${BASE_API:-https://login.charlott.ai/api}"
TOKEN="${TOKEN:-}"

pass(){ echo "[OK] $*"; }
fail(){ echo "[FAIL] $*"; exit 1; }

code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_WEB")
[[ "$code" == "200" ]] && pass "Frontend responde 200" || fail "Frontend code=$code"

code=$(curl -s -o /dev/null -w "%{http_code}" "${BASE_API%/}/../health")
[[ "$code" == "200" ]] && pass "Health backend 200" || fail "Health backend code=$code"

if [[ -n "$TOKEN" ]]; then
  code=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TOKEN" "${BASE_API%/}/saved-replies")
  [[ "$code" == "200" ]] && pass "Saved replies list auth OK" || fail "Saved replies code=$code"
else
  echo "[WARN] TOKEN no configurado. Salteando test autenticado."
fi

echo "SMOKE_OK"
