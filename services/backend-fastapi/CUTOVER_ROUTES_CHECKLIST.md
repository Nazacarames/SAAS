# FastAPI Cutover by Routes (Gradual)

## Goal
Switch `/api` traffic from Node to FastAPI incrementally with immediate rollback.

## Stage 1 (canary)
- Route 5% of authenticated internal traffic to FastAPI for:
  - `/api/auth/me`
  - `/api/users/*`
- Keep all writes mirrored to logs for parity checks.
- Rollback trigger: error rate > 1% or p95 > 1.5x baseline.

## Stage 2 (read-heavy)
- Switch reads to FastAPI:
  - `/api/contacts` (GET)
  - `/api/conversations` (GET)
  - `/api/messages/:id` (GET)
- Keep Node as fallback upstream.

## Stage 3 (write paths)
- Switch writes to FastAPI:
  - `/api/users` (POST)
  - `/api/contacts` (POST)
  - `/api/messages` (POST)
  - `/api/conversations/:id` (PUT)

## Stage 4 (auth core)
- Switch `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`.
- Verify cookies:
  - `token` path `/`
  - `refreshToken` path `/api/auth/refresh`

## Stage 5 (critical webhooks)
- Move `/api/whatsapp-cloud/webhook` only after idempotency parity + replay protection tests pass.

## Nginx strategy
- Use path-based upstream split, example:
  - Node upstream: `127.0.0.1:4000`
  - FastAPI upstream: `127.0.0.1:4010`
- Keep feature flag per route for instant rollback.

## Rollback
- Single toggle routes all traffic back to Node.
- Preserve FastAPI logs for diff analysis.
