#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "[verify] root: $ROOT"

run_if_pkg(){
  local dir="$1"
  local label="$2"
  if [ -f "$dir/package.json" ]; then
    echo "[verify] $label: npm ci"
    (cd "$dir" && npm ci)

    if (cd "$dir" && npm run | grep -q " typecheck"); then
      echo "[verify] $label: npm run typecheck"
      (cd "$dir" && npm run typecheck)
    else
      echo "[verify] $label: typecheck script missing (skip)"
    fi

    if (cd "$dir" && npm run | grep -q " lint"); then
      echo "[verify] $label: npm run lint"
      (cd "$dir" && npm run lint)
    else
      echo "[verify] $label: lint script missing (skip)"
    fi

    if (cd "$dir" && npm run | grep -q " test"); then
      echo "[verify] $label: npm test -- --runInBand"
      (cd "$dir" && npm test -- --runInBand || npm test)
    else
      echo "[verify] $label: test script missing (skip)"
    fi

    if (cd "$dir" && npm run | grep -q " build"); then
      echo "[verify] $label: npm run build"
      (cd "$dir" && npm run build)
    else
      echo "[verify] $label: build script missing (skip)"
    fi
  else
    echo "[verify] $label: package.json missing (skip)"
  fi
}

run_if_pkg "backend" "backend"
run_if_pkg "frontend" "frontend"

echo "[verify] done"
