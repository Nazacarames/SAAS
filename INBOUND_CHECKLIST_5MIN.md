# Inbound WhatsApp - Checklist 5 minutos

1) Enviar mensaje de prueba desde otro número al número conectado.
2) Confirmar llegada en teléfono (notificación + chat).
3) Confirmar aparición en CRM (lista de conversaciones + chat abierto).
4) Refrescar frontend y verificar que persiste (DB OK).
5) Verificar backend logs del momento exacto del envío.
6) Responder desde CRM y validar entrega en WhatsApp del emisor.

## Señales de falla típicas
- Llega al teléfono pero no al CRM: problema webhook/listener/socket/filtro inbox.
- Aparece y desaparece al refrescar: no persiste en DB.
- Llega tarde (>10s): latencia o cola/reintentos.
