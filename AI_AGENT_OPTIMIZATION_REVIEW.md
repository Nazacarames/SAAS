# Revisión técnica: Agente IA + RAG + Tokko

## Resumen ejecutivo

El repositorio tiene una **base operativa sólida** para multi-tenant, CRM, WhatsApp y Knowledge Base, pero hoy el módulo “Agente IA” está más cerca de un **framework de datos/herramientas** que de un asistente conversacional completo.

### Hallazgos principales

1. El sistema guarda configuración de agentes (`ai_agents`) y KB (`kb_documents`, `kb_chunks`), pero **no hay un orquestador LLM end-to-end** que use de forma consistente `persona + memoria + RAG + tools` para responder cada turno.
2. El RAG actual es FTS (`websearch_to_tsquery`) y funciona para recuperación básica, pero no tiene pipeline de calidad (query rewrite, reranking, grounding/citations, fallback semántico por embeddings).
3. Existe integración avanzada de features (templates, lead scoring, seguimientos, OAuth Meta, Tokko), pero de forma dispersa en `aiRoutes.ts` y con poco acoplamiento a una máquina conversacional única.
4. Tokko está bien encapsulado para inmobiliaria; falta endurecer cuándo/por qué se invoca para evitar “ruido” en clientes no inmobiliarios.

---

## Estado actual observado

- La UI de agentes permite configurar nombre/persona/welcome y activar/desactivar, pero no refleja una capa de runtime conversacional real. (`frontend/src/pages/AIAgents/index.tsx`)
- El backend ofrece CRUD de agentes, CRUD de documentos y búsqueda RAG por FTS. (`backend/src/routes/aiRoutes.ts`)
- El listener de WhatsApp guarda mensajes/tickets y emite eventos, pero no dispara una política de respuesta IA transaccional por turno. (`backend/src/services/WbotServices/wbotMessageListener.ts`)
- El stack incluye tablas útiles para conversaciones/turnos/tools (`ai_conversations`, `ai_turns`, `ai_tool_calls`) que hoy están subutilizadas. (`backend/src/database/migrations/20260211000009-ai-core.ts`)

---

## Causas probables de “no del todo conversacional”

1. **Falta de state machine conversacional**
   - No hay un ciclo explícito: clasificar intención → recuperar contexto → generar respuesta → decidir tool call → validar guardrails → enviar → registrar feedback.
2. **Memoria corta/larga no orquestada**
   - Se guardan mensajes, pero no hay una estrategia consistente de resumen de conversación, memoria de preferencias del cliente y slots de información faltante.
3. **RAG sin “grounding fuerte”**
   - Recupera chunks, pero no obliga a responder con evidencia, ni maneja bien preguntas ambiguas/multi-idioma/typos.
4. **Prompts no parametrizados por vertical**
   - Falta un esquema de “plantilla base por industria + custom del cliente” para escalar 100% personalización sin romper consistencia.

---

## Plan de optimización (priorizado)

## P0 — Conversacionalidad y estabilidad (impacto inmediato)

1. **Crear un `ConversationOrchestrator` único**
   - Archivo sugerido: `backend/src/services/AIServices/ConversationOrchestrator.ts`
   - Flujo por cada inbound:
     1) Detección de idioma e intención.
     2) Extracción de slots (presupuesto, zona, tipo, etc. según vertical).
     3) Query rewrite para RAG.
     4) Recuperación híbrida (FTS + embeddings cuando estén disponibles).
     5) Generación con prompt estructurado (persona + políticas + contexto de negocio + historial resumido + KB snippets).
     6) Decisión de tool call (si aplica).
     7) Validación de guardrails y fallback.
     8) Persistencia de trazas (`ai_turns`, `ai_tool_calls`, `ai_decision_logs`).

2. **Fallbacks controlados por confianza**
   - Si score RAG bajo o alta ambigüedad: responder con pregunta de clarificación en lugar de inventar.
   - Si proveedor LLM falla: responder plantilla de contingencia + derivación a humano.

3. **Respuesta más “humana” por diseño**
   - Prompt de estilo con reglas explícitas:
     - Mensajes cortos por WhatsApp.
     - Una pregunta por turno.
     - Confirmación de entendimiento.
     - Siguiente acción clara.

4. **Idempotencia y anti-duplicados en envío**
   - Reusar estrategia de dedupe outbound en toda respuesta IA para evitar mensajes repetidos en retries.

## P1 — RAG de producción

1. **Embeddings reales + índice vectorial**
   - Actualmente `embedding_json` está vacío en chunks.
   - Recomendado: columna vector (`pgvector`) + embeddings (`text-embedding-3-small` o equivalente).

2. **RAG híbrido**
   - Combinar score FTS + vector score + boosts por categoría/frescura.

3. **Reranking**
   - Top-20 recuperación, rerank a top-5 con modelo liviano.

4. **Chunking semántico**
   - No sólo por caracteres: separar por títulos/secciones/Q&A para mejorar precisión.

5. **Citas internas en respuesta**
   - Guardar IDs/títulos de chunks usados para auditoría y debugging.

## P2 — Arquitectura multi-vertical (100% personalizable por cliente)

1. **Blueprint por tenant**
   - Config JSON por empresa:
     - `industry` (inmobiliaria, salud, retail, etc.)
     - `tone`, `businessGoals`, `blockedTopics`
     - `requiredSlots` por intención
     - `toolsEnabled`

2. **Skills por vertical**
   - Skill `real_estate`: buscar propiedades, agendar visita, simular crédito.
   - Skill `generic_sales`: precios, demo, onboarding, soporte.

3. **Tool router condicional**
   - Tokko sólo se habilita si:
     - `industry = real_estate` y
     - `tokkoEnabled = true`.
   - Para otros verticales: jamás llamar Tokko.

4. **Políticas por canal**
   - WhatsApp requiere respuestas más breves y secuenciales que web chat.

## P3 — Observabilidad y mejora continua

1. **Métricas de calidad conversacional**
   - `first_response_time`, `handoff_rate`, `resolution_rate`, `avg_turns_to_resolution`, `rag_hit_rate`, `fallback_rate`.

2. **Evaluación offline de prompts/RAG**
   - Dataset de 100-300 conversaciones reales anonimizadas.
   - Bench automático antes de deploy.

3. **A/B testing por versión de prompt**
   - Versionar `system_prompt_version` por tenant y comparar KPIs.

4. **Panel de errores integraciones**
   - Ya existe `integration_errors`; sumar alertas accionables por umbral.

---

## Tokko: recomendaciones específicas (inmobiliaria)

1. **Gating estricto por industria**
   - No basta con `tokkoEnabled`; agregar validación de tipo de negocio del tenant.

2. **Modo “safe write” por defecto**
   - En creación/sync de leads, confirmar datos mínimos antes de POST.

3. **Cache de búsquedas frecuentes**
   - Reducir latencia y costos API.

4. **Explicabilidad al usuario**
   - Si se usan datos de Tokko, responder “te muestro opciones según [zona/presupuesto/tipo]”.

---

## Quick wins (1–2 semanas)

1. Separar `aiRoutes.ts` en módulos (`agents`, `kb`, `meta`, `crm`, `templates`) para mantenibilidad.
2. Agregar endpoint `/ai/respond` único que ejecute orquestación completa.
3. Persistir `conversation_summary` cada N turnos para memoria corta eficiente.
4. Añadir `industry` y `ai_config_json` en `companies` o tabla `tenant_ai_profiles`.
5. En frontend, crear “Test Playground” de prompt + RAG con trazas visibles.

---

## Riesgos si no se corrige

- Respuestas inconsistentes entre clientes.
- Baja percepción de “asistente inteligente” (parece bot rígido).
- Dificultad para escalar a múltiples verticales.
- Mayor costo operativo por intervención humana.

---

## Conclusión

Tu plataforma ya tiene las piezas correctas (multi-tenant, tickets, KB, tools, Meta, Tokko), pero necesita una **capa de orquestación conversacional formal** para cumplir el objetivo de “100% personalizado por cliente” con estabilidad.

El mayor salto de calidad vendrá de:
1) Orquestador único por turno, 2) RAG híbrido con grounding, 3) configuración por vertical/tenant, 4) observabilidad con métricas de calidad.

Si quieres, en el próximo paso puedo proponerte el diseño técnico exacto (interfaces TypeScript + contratos JSON + orden de implementación sprint por sprint) para que lo ejecutes con mínimo riesgo.
