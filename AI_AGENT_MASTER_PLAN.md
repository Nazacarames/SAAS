# AI Agents en LMTM CRM - Plan Maestro (ejecución)

## Objetivo
Integrar agente conversacional + tool-calling + RAG + intervención humana sobre WhatsApp.

## Fase 1 (en ejecución)
- [x] Observabilidad inbound
- [x] Fallback polling en pantalla de tickets
- [x] Base para WhatsApp Cloud webhook
- [ ] Endpoint de tool-calling backend (MCP-like)
- [ ] Configuración de agente en DB + panel

## Fase 2 (tool-calling operativo)
Tools iniciales:
1. `upsert_contact`
2. `agendar_cita`
3. `reprogramar_cita`
4. `cancelar_cita`
5. `consultar_conocimiento`
6. `actualizar_lead_score`
7. `agregar_nota`

## Fase 3 (RAG)
- Ingesta documentos (FAQ/Productos/Políticas)
- Embeddings + búsqueda semántica
- Endpoint de test de relevancia

## Fase 4 (autonomía con guardrails)
- Bot ON/OFF por ticket
- detección anti-spam/jailbreak básico
- fallback a humano automático

## Fase 5 (analítica)
- Conversión por etapa
- performance IA vs humano
- tiempos de respuesta

## Reglas de despliegue
- backup predeploy
- smoke tests
- rollback script
