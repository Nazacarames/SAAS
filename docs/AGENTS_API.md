# LMTM CRM — Guía de API para agentes (LMTM-OS)

Doc para el agente que administra el CRM. Verificado contra producción el 2026-07-03.

## Conexión

- **URL base**: `https://crm.lmtmas.com/api`
- **Auth**: JWT Bearer. Login devuelve `token` (expira en **15 minutos**) — el agente debe re-loguear cuando reciba 401 (no usar refresh cookie desde scripts; re-login es más simple).
- **Header exacto**: `Authorization: Bearer <token>`
- **Usuario de servicio**: `agentes@bylmtm.com` (profile `super`, opera sobre todas las empresas). La credencial se entrega por canal seguro; guardarla en el secret store de LMTM-OS, nunca en repos ni prompts.
- **Rate limit login**: 10 intentos / 15 min por IP → cachear el token, no loguear por request.

### Login
```
POST /api/auth/login
Body: {"email": "agentes@bylmtm.com", "password": "<SECRET>"}
→ 200 {"user": {...}, "token": "<JWT>"}   (401 credenciales malas, 429 rate limit)
```

### Curl real (probado)
```bash
TOKEN=$(curl -s -X POST https://crm.lmtmas.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"agentes@bylmtm.com","password":"<SECRET>"}' | jq -r .token)

curl -s https://crm.lmtmas.com/api/admin/overview -H "Authorization: Bearer $TOKEN"
# → {"ok":true,"totals":{"companies":9,...,"mrr_ars":130000.0},...}
```

## Roles

| Profile | Puede |
|---|---|
| `user` | Operador: conversaciones, contactos/leads, agenda de SU empresa |
| `admin` | Todo lo de user + agentes IA, canales, usuarios, billing, config de SU empresa |
| `super` | Todo + panel `/api/admin/*`: todas las empresas, planes, suscripciones, facturas |

**Multi-tenant**: el `companyId` sale del JWT. Un token solo ve su empresa; `super` administra todas vía `/api/admin/*`, pero los endpoints operativos (contactos, canales, agentes) siguen actuando sobre la empresa del token. Para operar DENTRO de la empresa de un cliente hay que loguear con un usuario de esa empresa (crearlo vía registro o pedirle credencial al cliente).

## Alta de cliente (empresa) y usuarios

### Crear CLIENTE (empresa + primer admin + trial 30 días, todo junto)
```
POST /api/auth/register      (público, rate limit 5/15min por IP)
Body: {"name": "Juan Pérez", "email": "juan@inmo.com", "password": "min8chars", "companyName": "Inmobiliaria Pérez"}
→ 201 {"ok":true, "user": {...}, "token": "<JWT del nuevo admin>"}
```
Crea: empresa + usuario `admin` + suscripción `trialing` 30 días (límites Pro) + KB con plantillas. **Así se le da acceso al cliente final**: se registra él o lo registrás vos y le pasás email+password (que cambie en el primer ingreso; puede activar 2FA en /security).

### Crear USUARIO adicional (operador dentro de una empresa)
```
POST /api/users/        (requiere token admin DE ESA empresa)
Body: {"name": "Vendedor 1", "email": "v1@inmo.com", "password": "min8chars", "profile": "user"}
→ 201 {"id":.., "name":.., "email":.., "profile":"user", "companyId":..}
```
`profile`: `"user"` (operador) o `"admin"`. GET `/api/users/` lista los de la empresa.

## Operaciones frecuentes (método + path + body)

### Conectar WhatsApp/IG/Messenger a un cliente (con token admin del cliente)
1. `POST /api/channels/discover` — Body `{"access_token": "<token Meta del cliente>"}` → lista números WhatsApp, cuentas IG y páginas detectadas (`already_connected` marca las ya usadas). **Preferir siempre este flujo.**
2. `POST /api/channels` — Body: `{"channel_type": "whatsapp"|"instagram"|"messenger", "name": "WhatsApp Ventas", "external_id": "<phone_number_id | ig_id | page_id>", "access_token": "<token>", "app_secret": "<opcional, recomendado>"}` → devuelve el canal con `verify_token`.
3. Configurar en Meta Developers el webhook: Callback `https://crm.lmtmas.com/webhooks/meta` + el `verify_token` devuelto (uno solo por empresa).
4. `POST /api/channels/{id}/test` → `{"ok": true, "data": {...}}` valida el token contra Graph.
5. `GET /api/channels/health` → estado de tokens de todos los canales (cache 60s).

### Pipeline / embudo (token del cliente)
- `GET /api/pipeline/stages` — etapas. `GET /api/pipeline/board` — tablero con leads por etapa.
- `POST /api/pipeline/stages` — `{"name": "Visita", "color": "#34D399"}`; `PUT /api/pipeline/stages/{id}` — renombrar/color/`is_won`; `DELETE /api/pipeline/stages/{id}`; `PUT /api/pipeline/reorder` — `{"stage_ids": [3,1,2]}`.
- Mover lead: `PUT /api/pipeline/leads/{contact_id}/stage` — `{"stage_id": 5}`.

### Leads / contactos (token del cliente)
- `GET /api/contacts/` lista; `POST /api/contacts/` crea (`{"name","number","email?","source?","leadStatus?","assignedUserId?"}`).
- **Asignar lead a operador**: `PUT /api/contacts/{id}` — `{"assignedUserId": 12}`.
- Recalcular score: `POST /api/ai/leads/{contact_id}/recalculate-score`.
- **Campos custom**: NO existen como feature. Lo más cercano: `tags` (ids), `progress_tags` (strings libres), `business_type`, `needs` en el contacto — usables vía `PUT /api/contacts/{id}`.

### Agente IA del cliente (token admin del cliente)
- `GET /api/ai/agents` / `POST /api/ai/agents` (`{"name","persona","welcomeMsg?","offhoursMsg?","farewellMsg?","businessHoursJson?","isActive":true}`) / `PUT /api/ai/agents/{id}` / `DELETE`.
- Probar sin enviar nada real: `POST /api/ai/agents/test-chat` — `{"message":"...","history":[],"slots":{},"conversationState":"new"}` (dry-run: pipeline completo, cero escritura).

### Administración de plataforma (solo agentes@bylmtm.com)
- `GET /api/admin/overview` — MRR, empresas, trials. `GET /api/admin/companies` — todas con plan/uso/trial.
- `PUT /api/admin/companies/{id}/subscription` — `{"planCode"?, "status"?, "extendTrialDays"?, "billingBypass"?}`.
- `PUT /api/admin/companies/{id}/active` — `{"active": false}` suspende.
- `GET /api/admin/plans` / `POST /api/admin/plans` / `PUT /api/admin/plans/{code}` — planes (enterprise incluido).
- `GET /api/admin/invoices` — facturas ARCA. `POST /api/admin/arca/dummy` — test conectividad.

## Base de datos (referencia — los agentes NO acceden directo)

Postgres 18, DB `atendechat`, solo accesible desde el VPS (no exponer; los agentes usan la API, nunca psql). Tablas clave (ojo: columnas legacy en camelCase requieren comillas):

- `companies` (id, name, email, status) — 1:N con todo lo demás.
- `users` (id, name, email, "passwordHash", profile, "companyId").
- `contacts` = leads (id, name, number, email, "companyId", "leadStatus", lead_score, "assignedUserId", stage_id→lead_stages, channel_id→channels, tags, progress_tags, needs).
- `lead_stages` (id, company_id, name, color, position, is_won) — el Kanban.
- `channels` (id, company_id, channel_type, external_id, meta_connection_id→meta_connections, config_json{verifyToken,appSecret}, status) — conexiones WhatsApp/IG/Messenger. `meta_connections.access_token` va CIFRADO (Fernet).
- `messages`, `tickets` — conversaciones. `ai_agents` — config del bot. `appointments` — agenda.
- `billing_plans`, `company_subscriptions`, `subscriptions` (trial), `usage_counters`, `invoices` (ARCA).

## Reglas para los agentes

**NUNCA (prohibido, ni con OK humano — lo hace Nazareno a mano):**
- DELETE de empresas, usuarios o contactos en producción. Borrar/desactivar canales de un cliente activo.
- Tocar credenciales: `.env`, tokens Meta guardados, `meta_connections`, certificados ARCA, passwords ajenas.
- Acceso directo a Postgres o SSH. Solo API.
- Cambiar `billingBypass`, suspender empresas, o editar precios de planes existentes.
- Enviar mensajes de WhatsApp/IG a contactos reales de clientes.

**REQUIEREN OK humano previo (proponer → esperar aprobación):**
- Crear empresa/cliente nuevo. Crear usuarios en empresas de clientes.
- Conectar/editar canales (tocan producción del cliente).
- Cambiar plan o extender trial de una empresa. Crear planes nuevos.
- Editar persona/config del agente IA de un cliente activo.

**LIBRES (sin aprobación):**
- Todos los GET (lectura de todo). `POST /api/ai/agents/test-chat` (dry-run). `POST /api/channels/{id}/test` y `/api/channels/health`. `POST /api/admin/arca/dummy`.
- Crear/editar etapas de pipeline y asignar leads a operadores **si el cliente lo pidió**.

**Producción**: sí operan sobre datos reales — por eso el esquema de arriba: lectura libre, escritura acotada con OK humano, destrucción prohibida.
