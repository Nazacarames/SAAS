# WhatsApp Cloud API - Migración (LMTM CRM)

## Estado actual
- Endpoint backend listo: `GET/POST /api/whatsapp-cloud/webhook`
- Procesamiento inbound conectado a CRM (crea/actualiza contact, ticket y mensajes)
- Métricas inbound disponibles en `/health/messages`

## Variables necesarias (pendiente completar)
- `WA_CLOUD_VERIFY_TOKEN`
- `WA_CLOUD_PHONE_NUMBER_ID`
- `WA_CLOUD_ACCESS_TOKEN`
- `WA_CLOUD_APP_SECRET` (opcional para firma)
- `WA_CLOUD_DEFAULT_WHATSAPP_ID` (id de conexión CRM destino)

## Pasos Meta
1. Crear app en Meta Developers
2. Activar WhatsApp product
3. Obtener `Phone Number ID` + token
4. Configurar webhook callback:
   - URL: `https://login.charlott.ai/api/whatsapp-cloud/webhook`
   - Verify token: `WA_CLOUD_VERIFY_TOKEN`
5. Suscribir eventos de mensajes

## Prueba de verificación
Meta hará GET con:
- `hub.mode`
- `hub.verify_token`
- `hub.challenge`

Si token coincide, backend responde challenge (200).

## Prueba de recepción
Enviar mensaje de WhatsApp al número cloud y verificar:
1) aparece en CRM
2) aparece en `/health/messages` (`inboundTotal` sube)
3) logs backend muestran `[wa-cloud][inbound]`

## Rollback
- Mantener sesión Web/QR activa en paralelo hasta validar 48h sin pérdida.
