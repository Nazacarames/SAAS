# AI Backend Consolidation

## Status: In Progress

## Decision: Node.js is Primary Backend

After reviewing both AI backends, **Node.js (`ConversationOrchestrator.ts`) is the recommended primary backend** because:

1. **More advanced architecture**: ReAct agent loop with forced first-tool calling
2. **Better RAG**: Uses PostgreSQL full-text search with `ts_rank_cd`
3. **Contact enrichment**: Automatically enriches prompts with contact context
4. **Sanitization**: Better input sanitization for LLM prompts
5. **Active development**: More recent improvements

## FastAPI Backend (Python) - DEPRECATED

The FastAPI backend at `services/backend-fastapi/` should be phased out:

- **Webhook**: Fixed to use company_id properly (see webhook_whatsapp.py)
- **AI Agent**: Only use for migration/transition period
- **All new AI features should be implemented in Node.js**

## Tools Implementation Status

| Tool | Status | Backend |
|------|--------|---------|
| search_properties | ✅ Complete | Both |
| search_knowledge_base | ✅ Complete | Node.js |
| agendar_cita | ✅ Implemented | Node.js |
| reprogramar_cita | ✅ Implemented | Node.js |
| cancelar_cita | ✅ Implemented | Node.js |
| actualizar_lead_score | ✅ Implemented | Node.js |
| agregar_nota | ✅ Implemented | Node.js |

## Next Steps

1. ~~Deprecate FastAPI AI endpoints~~
2. ~~Migrate all AI calls to Node.js `/api/ai/*` endpoints~~
3. Implement proper RAG with pgvector (see RAG_VECTORIAL_IMPLEMENTATION.md)
4. Add analytics tracking for AI conversations
5. Implement proactive guardrails (spam/jailbreak detection)

## RAG Vectorial Implementation

See `RAG_VECTORIAL_IMPLEMENTATION.md` for the plan to implement true vector-based RAG.
