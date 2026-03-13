#!/usr/bin/env bash
set -euo pipefail

BASE_API="${BASE_API:-https://login.charlott.ai/api}"
HARDENING_TOKEN="${HARDENING_TOKEN:-${WA_HARDENING_TOKEN:-}}"
FAIL_ON_ALERT="${FAIL_ON_ALERT:-0}"

pass(){ echo "[OK] $*"; }
fail(){ echo "[FAIL] $*"; exit 1; }
warn(){ echo "[WARN] $*"; }

health_url="${BASE_API%/}/../health"
code=$(curl -s -o /dev/null -w "%{http_code}" "$health_url")
[[ "$code" == "200" ]] && pass "Backend health responde 200" || fail "Backend health code=$code"

if [[ -z "$HARDENING_TOKEN" ]]; then
  warn "HARDENING_TOKEN/WA_HARDENING_TOKEN no configurado. Salteando consulta protegida /whatsapp-cloud/webhook/hardening"
  echo "HARDENING_SMOKE_PARTIAL"
  exit 0
fi

hardening_url="${BASE_API%/}/whatsapp-cloud/webhook/hardening?failOnAlert=${FAIL_ON_ALERT}"
response_file=$(mktemp)
http_code=$(curl -sS -o "$response_file" -w "%{http_code}" \
  -H "x-hardening-token: ${HARDENING_TOKEN}" \
  "$hardening_url")

if [[ "$http_code" != "200" && "$http_code" != "503" ]]; then
  cat "$response_file" >&2 || true
  fail "Hardening endpoint devolvió HTTP $http_code"
fi

python3 - "$response_file" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)

required_paths = [
    ("health",),
    ("summary",),
    ("inbound", "counters"),
    ("outbound", "counters"),
    ("alerts", "inbound"),
    ("alerts", "outbound"),
    ("signatureHardening",),
    ("webhookPayloadReplayHardening",),
    ("outboundRetryHardening",)
]

def has_path(obj, path):
    cur = obj
    for key in path:
        if not isinstance(cur, dict) or key not in cur:
            return False
        cur = cur[key]
    return True

missing = [".".join(p) for p in required_paths if not has_path(data, p)]
if missing:
    raise SystemExit(f"faltan campos esperados en hardening: {', '.join(missing)}")

inbound = data.get("inbound", {}).get("counters", {})
outbound = data.get("outbound", {}).get("counters", {})

expected_metric_keys = [
    "inbound.replay_blocked",
    "outbound.duplicate_blocked",
]
absent = []
for key in expected_metric_keys:
    if key.startswith("inbound") and key not in inbound:
        absent.append(key)
    if key.startswith("outbound") and key not in outbound:
        absent.append(key)

if absent:
    raise SystemExit(f"faltan métricas clave para hardening anti-duplicados/replay: {', '.join(absent)}")

health_status = str(data.get("health", {}).get("status", "unknown"))
print(f"health_status={health_status}")
PY

if [[ "$http_code" == "503" ]]; then
  warn "Hardening endpoint respondió 503 (failOnAlert activo y hay alertas)."
else
  pass "Hardening endpoint respondió OK"
fi

rm -f "$response_file"
echo "HARDENING_SMOKE_OK"