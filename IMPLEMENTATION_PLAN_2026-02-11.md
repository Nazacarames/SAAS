# Charlott CRM - Plan de implementación (inicio inmediato)

Fecha: 2026-02-11
Owner: Claw + Naza

## Objetivo
Mejorar estabilidad de inbound WhatsApp, visibilidad operativa, UX de conversaciones y seguridad de despliegue sin romper producción.

## Fase 0 (ahora - completado)
- [x] Validación deploy frontend OK (HTTP 200)
- [x] Validación endpoint delete saved-replies OK (204)
- [x] Verificación acceso SSH y estado backend PM2 online
- [x] Resguardo: rollback rápido disponible vía backups existentes

## Fase 1 (hoy) - Observabilidad + QA automatizable
1. Crear smoke test post-deploy (frontend + backend + auth opcional)
2. Agregar checklist de verificación inbound teléfono ↔ CRM ↔ backend
3. Definir formato de logs inbound para trazabilidad (messageId/ticketId/latencia)

Entregables hoy:
- script de smoke tests
- checklist operativo
- plan técnico de cambios de código (sin despliegue riesgoso)

## Fase 2 (próximo bloque) - Confiabilidad inbound realtime
1. Instrumentación backend en listener inbound:
   - log estructurado por mensaje
   - contador de duplicados
   - contador de errores de procesamiento
2. Endpoint de health de mensajería (`/health/messages`) con métricas básicas
3. Fallback de reconexión/socket para evitar “no se ve en UI”

Criterio de éxito:
- detectar en <1 minuto si inbound cae
- tiempo medio inbound->UI visible y medible

## Fase 3 - UX conversaciones tipo WhatsApp Web (MVP)
1. Sidebar con búsqueda + preview + hora + unread badge
2. Header de conversación claro (contacto, estado, acciones)
3. Composer robusto (enter/shift+enter, adjuntos, estados)
4. Indicadores de envio/lectura más evidentes

## Fase 4 - Seguridad operativa
1. Migrar SSH a key-only (desactivar password login)
2. Rotación de secretos críticos
3. hardening básico sshd + fail2ban + updates

## Riesgos y mitigación
- Riesgo: cambios backend en caliente rompan flujo inbound
  - Mitigación: branch + build + deploy por etapas + smoke + rollback
- Riesgo: integración WA Web/QR siga inestable
  - Mitigación: definir migración a WhatsApp Cloud API como roadmap prioritario

## Próximo paso inmediato en ejecución
- Entregar y subir script de smoke test reutilizable
- Ejecutarlo contra producción y reportar resultado
