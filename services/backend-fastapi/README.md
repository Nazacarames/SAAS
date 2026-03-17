# Charlott FastAPI Backend (Migration Track)

## Run local

```bash
cd services/backend-fastapi
python -m venv .venv
# windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --reload --port 4010
```

## Run tests

```bash
cd services/backend-fastapi
python -m pytest tests/ -v
```

---

## Auth Endpoints

### `POST /api/auth/login`

**Request:**
```json
{ "email": "user@example.com", "password": "secret123" }
```

**Response 200:**
```json
{
  "user": { "id": 1, "name": "John", "email": "user@example.com", "profile": "admin", "companyId": 10 },
  "token": "<jwt>"
}
```
Sets cookies: `token` (path `/`), `refreshToken` (path `/api/auth/refresh`). Both `HttpOnly`.

**Response 401:** `{ "detail": "Credenciales inválidas" }`

### `POST /api/auth/refresh`

**Request (JSON body or `refreshToken` cookie):**
```json
{ "refreshToken": "<jwt>" }
```

**Response 200:**
```json
{ "ok": true, "token": "<new-access-jwt>" }
```
Rotates both cookies. Old refresh token is revoked in DB.

**Response 401:** `{ "detail": "Refresh token inválido" }`

### `POST /api/auth/logout`

Requires `Authorization: Bearer <token>` header or `token` cookie.

**Response 200:** `{ "ok": true }`

Clears `token` and `refreshToken` cookies. Revokes all user refresh tokens in DB.

### `GET /api/auth/me`

Requires auth. **Response 200:**
```json
{
  "user": { "id": 1, "name": "John", "email": "user@example.com", "profile": "admin", "companyId": 10 }
}
```

---

## Contacts Endpoints

### `GET /api/contacts/`

Query params: `status`, `assignedUserId`, `limit` (1-500, default 200).

**Response 200:** array of `ContactOut`.

### `POST /api/contacts/`

**Request:**
```json
{ "name": "John", "number": "5511999990000", "email": "j@example.com" }
```
**Response 201:** `ContactOut`.

### `PUT /api/contacts/{contactId}`

**Request (all fields optional):**
```json
{
  "name": "Jane", "number": "5511999990001", "email": "jane@x.com",
  "leadStatus": "qualified", "assignedUserId": 5,
  "inactivityMinutes": 60, "tags": [1, 3]
}
```
**Response 200:** updated `ContactOut`. **404** if not found.

### `DELETE /api/contacts/{contactId}`

**Response 204** (no body). Deletes messages first, then contact. **404** if not found.

### `POST /api/contacts/{contactId}/mark-read`

Sets `leadStatus = "read"` and updates `lastInteractionAt`.

**Response 200:** updated `ContactOut`. **404** if not found.

---

## Conversations Endpoints

### `GET /api/conversations/`

Query params: `status`, `contactId`, `page`, `limit`.

**Legacy mode** (no `page`/`limit`): returns plain array.

**Paginated mode** (`page` and/or `limit` provided):
```json
{
  "data": [...],
  "total": 42,
  "page": 1,
  "limit": 50,
  "totalPages": 1
}
```

### `PUT /api/conversations/{conversationId}`

**Request:**
```json
{ "status": "closed", "userId": 3 }
```
**Response 200:**
```json
{ "conversationId": 100, "leadStatus": "closed", "assignedUserId": 3 }
```

---

## Messages Endpoints

### `GET /api/messages/{conversationId}`

Query params: `page`, `limit`.

**Legacy mode** (no `page`/`limit`): returns plain array of messages.

**Paginated mode**:
```json
{
  "data": [...],
  "total": 150,
  "page": 1,
  "limit": 50,
  "totalPages": 3
}
```

### `POST /api/messages/`

**Request:**
```json
{ "body": "Hello!", "contactId": 100 }
```

**Headers (optional):**
- `x-idempotency-key` / `idempotency-key` — alphanumeric + `:_-.`, max 120 chars
- `x-retry-attempt` / `x-retry-count` — integer 1-1000

**Validation errors (400):**
- `idempotencyKey contains invalid characters`
- `idempotencyKey too long (max 120)`
- `idempotencyKey mismatch between sources` (header vs body conflict)
- `retryAttempt invalid (allowed integer range: 1..1000)`
- `retryAttempt too high`
- `retryAttempt > 1 requires an explicit idempotencyKey`

**Response 201:** `MessageOut`.

---

## Cookie compatibility with frontend

| Cookie         | Path                 | HttpOnly | Secure       | SameSite          |
|----------------|----------------------|----------|--------------|-------------------|
| `token`        | `/`                  | yes      | prod only    | `none` / `lax`    |
| `refreshToken` | `/api/auth/refresh`  | yes      | prod only    | `none` / `lax`    |

- **Production:** `secure=true`, `sameSite=none` (cross-origin)
- **Development:** `secure=false`, `sameSite=lax`

## Environment variables

| Variable               | Default             |
|------------------------|---------------------|
| `JWT_SECRET`           | `change-me`         |
| `JWT_REFRESH_SECRET`   | `change-me-refresh` |
| `DB_HOST`              | `localhost`          |
| `DB_PORT`              | `5432`              |
| `DB_USER`              | `postgres`          |
| `DB_PASS`              | `postgres`          |
| `DB_NAME`              | `atendechat`        |
| `ENVIRONMENT`          | `development`       |

## Migration strategy

This service starts as parity adapter for Node routes, then progressively becomes the primary backend.

## Nginx cutover helpers

- `services/backend-fastapi/scripts/apply_nginx_cutover.sh`
  - backup current `/etc/nginx/sites-enabled/charlott-frontend`
  - apply cutover config
  - validate with `nginx -t`
  - auto-restore on failure
- `services/backend-fastapi/scripts/rollback_nginx_cutover.sh <backup-file>`
  - restore specific backup and reload nginx
