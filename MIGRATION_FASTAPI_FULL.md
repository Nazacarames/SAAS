# Migración total Node.js -> FastAPI (ejecución continua)

## Estado actual
- Sprint 0 iniciado.
- FastAPI base creado en `services/backend-fastapi`.
- Endpoint paridad inicial implementado: `GET /api/auth/me`.

## Objetivo
Reemplazar backend Node en producción por FastAPI con cero downtime perceptible y rollback inmediato.

## Fases

### Fase 1 — Paridad Auth/Core
- [x] `/api/auth/me`
- [ ] `/api/auth/login`
- [ ] `/api/auth/refresh`
- [ ] `/api/auth/logout`
- [ ] `/api/users/*`

### Fase 2 — CRM Core
- [ ] `/api/contacts/*`
- [ ] `/api/conversations/*`
- [ ] `/api/messages/*`
- [ ] `/api/settings/*`

### Fase 3 — Integraciones críticas
- [ ] `/api/whatsapp-cloud/webhook`
- [ ] outbound message pipeline + idempotencia
- [ ] `/api/integrations/*`

### Fase 4 — IA y conocimiento
- [ ] `/api/ai/*`
- [ ] `/api/saved-replies/*`

### Fase 5 — Billing/Reportes
- [ ] `/api/billing/*`
- [ ] `/api/reports/*`

### Fase 6 — Cutover
- [x] Nginx switch `/api` -> FastAPI
- [x] Webhook y socket.io permanecen en Node (excepción permanente por criticidad)
- [ ] Node en standby (opcional,取决于 negocio)

## Reglas operativas
1. Cada endpoint migrado debe tener test de contrato.
2. Cualquier endpoint nuevo en Node queda bloqueado salvo hotfix crítico.
3. Deploy con rollback documentado por release.
4. No cutover global hasta cubrir auth + core + webhook.

## Próximo bloque (automático)
1) Migrar login/refresh/logout a FastAPI
2) Agregar tablas/queries parity para users y refresh token
3) Wire de frontend contra FastAPI en entorno de staging
