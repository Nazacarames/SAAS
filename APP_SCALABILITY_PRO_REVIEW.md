# Plan de mejoras para una app funcional, profesional y escalable

## 1) Backend architecture
- **Separar `aiRoutes.ts` por dominios** (`agents`, `kb`, `orchestrator`, `integrations`, `crm`) para reducir riesgo de regresiones.
- **Capa de servicios** consistente (controller -> service -> repository) y evitar lógica SQL extensa en rutas.
- **Procesamiento asíncrono con jobs** (BullMQ/Redis) para tareas pesadas: RAG indexing, follow-ups, sync integraciones.

## 2) IA conversacional
- Mantener `ConversationOrchestrator` como entrypoint único por turno.
- Agregar **machine state por conversación** (new/qualifying/negotiation/handoff/closed).
- Guardrails por tenant: límites de longitud, tono, temas prohibidos, handoff automático.

## 3) RAG
- Migrar de FTS-only a **híbrido FTS + embeddings** (pgvector).
- Ingesta incremental y versionada por documento.
- Re-ranking y trazabilidad de citas (chunk IDs usados por respuesta).

## 4) Integraciones (Tokko/Meta/WhatsApp)
- **Feature flags por tenant** para habilitar cada integración.
- Tokko sólo para vertical inmobiliario (gating estricto por `business_type`/industry).
- Retry/backoff + circuit breaker en APIs externas.

## 5) Seguridad y cumplimiento
- Secret manager para tokens (no archivos locales para producción).
- Auditoría de acciones sensibles (quién cambió prompts, keys, plantillas).
- Rate-limits por endpoint y por tenant.

## 6) Observabilidad
- Logs estructurados con correlation-id (`ticketId`, `contactId`, `companyId`).
- Métricas: latencia IA, fallback rate, handoff rate, respuesta exitosa, errores por integración.
- Alertas (Sentry + dashboards de negocio/operación).

## 7) Datos y performance
- Índices en columnas críticas de filtros/joins.
- Paginación obligatoria en listados grandes.
- Cache para consultas frecuentes (config tenant, KB stats, catálogos).

## 8) Calidad y DX
- Tests unitarios de orquestación + integration tests de endpoints críticos.
- Contratos de API con esquemas (zod/openapi) y validación estricta.
- CI/CD con gates: lint, typecheck, tests, migraciones dry-run.

## 9) Frontend profesional
- Estado robusto (React Query) para caché/reintentos.
- Manejo centralizado de errores y skeletons de carga.
- Página de “AI Playground” para probar prompt+KB+respuesta con trazas.

## 10) Roadmap sugerido
- **Sprint 1:** separar rutas IA + validación de contratos + métricas básicas.
- **Sprint 2:** RAG híbrido + pipeline de embeddings.
- **Sprint 3:** state machine conversacional + handoff inteligente.
- **Sprint 4:** hardening seguridad + CI/CD enterprise.
