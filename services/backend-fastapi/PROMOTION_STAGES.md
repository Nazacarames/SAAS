# Promotion Stages (Canary -> Reads -> Writes)

## Stage A — Canary (auth/users only)
- Keep default `/api` on Node.
- Enable FastAPI only for:
  - `/api/auth/me`
  - `/api/users/*`
  - gated by `x-api-canary: 1`

### Exit criteria
- 30-60 min stable
- no auth regression
- 5xx < 1%, p95 not worse than 1.5x baseline

## Stage B — Read routes to FastAPI
Promote:
- `GET /api/contacts`
- `GET /api/conversations`
- `GET /api/messages/{id}`

### Exit criteria
- 60 min stable
- response shape parity validated by frontend smoke

## Stage C — Write routes to FastAPI
Promote:
- `POST /api/contacts`
- `PUT /api/contacts/{id}`
- `DELETE /api/contacts/{id}`
- `POST /api/contacts/{id}/mark-read`
- `POST /api/messages`
- `PUT /api/conversations/{id}`

### Exit criteria
- idempotency/retry checks passing
- no data integrity drift in DB

## Stage D — Auth full cutover
Promote:
- `/api/auth/login`
- `/api/auth/refresh`
- `/api/auth/logout`

### Exit criteria
- login/logout loops = 0
- cookie behavior confirmed (token + refreshToken paths)

## Rollback rule (all stages)
- Any severe regression => restore last nginx backup + reload immediately.
