# LMTM CRM — Documentación técnica para desarrolladores de agentes

**Versión**: julio 2026 · **Producción**: https://crm.lmtmas.com · **Repo**: github.com/Nazacarames/SAAS
**Contacto**: grow@bylmtm.com

Este documento contiene todo lo necesario para integrar agentes automáticos (LMTM-OS u otros) con el CRM: arquitectura, autenticación, referencia completa de API, flujos end-to-end, modelo de datos y reglas de operación. Todos los endpoints fueron verificados contra producción en la fecha de esta versión.

---

## 1. Qué es LMTM CRM

CRM multi-tenant para inmobiliarias argentinas. Centraliza conversaciones de **WhatsApp, Instagram y Messenger** en una bandeja única, con un **agente de IA propio por empresa** que responde consultas, busca propiedades reales (integración Tokko Broker + geolocalización), califica leads, los mueve por un pipeline Kanban y agenda visitas con recordatorios automáticos.

**Modelo de negocio**: suscripción mensual (trial 30 días) cobrada por MercadoPago, con factura electrónica ARCA automática. Planes: Starter / Pro / Agencia / Enterprise (a medida) + fee único de instalación asistida.

### Stack

| Capa | Tecnología |
|---|---|
| Backend | Python 3.10 · FastAPI · 2 workers uvicorn en `127.0.0.1:4010` (systemd `charlott-fastapi`) |
| Frontend | React 18 + TypeScript + Vite + MUI, servido por nginx |
| Base de datos | PostgreSQL 18, DB `atendechat` (solo accesible desde el VPS) |
| IA | OpenAI (gpt-4o-mini por defecto, soporta fine-tuned `ft:...` por empresa) + RAG con embeddings |
| Mensajería | Meta Graph API v21 (WhatsApp Cloud, Instagram, Messenger) |
| Pagos / Facturación | MercadoPago Checkout + ARCA WSAA/WSFEv1 (Factura C) |
| Geo | Nominatim/OpenStreetMap con cache propio |

### Flujo de un mensaje entrante (referencia)

```
Cliente escribe por WhatsApp
  → Meta POST /webhooks/meta (firma HMAC validada por canal)
  → dispatcher identifica empresa+canal (multi-tenant)
  → guarda mensaje → orchestrator IA:
      extrae slots (zona, presupuesto, ambientes...) → clasifica intención
      → tools: búsqueda Tokko / geo "cerca de X" / agendar cita / guardar contacto
      → guardrails → responde por el mismo canal
  → actualiza lead_score y mueve el lead en el Kanban
```

---

## 2. Conexión y autenticación

- **URL base**: `https://crm.lmtmas.com/api`
- **Formato**: JSON. Header `Content-Type: application/json`.
- **Auth**: JWT Bearer → `Authorization: Bearer <token>`.
- **Expiración**: access token **15 minutos**. Ante un `401`, re-loguear (cachear el token entre llamadas; no loguear por request).
- **Rate limits**: login 10/15min por IP · registro 5/15min por IP.
- **Suscripción vencida**: el API devuelve `402 {"code":"subscription_required"}` en endpoints del panel (auth, billing y webhooks siguen abiertos).

### Login

```
POST /api/auth/login
{"email": "agentes@bylmtm.com", "password": "<SECRET>"}
→ 200 {"user": {"id","name","email","profile","companyId"}, "token": "<JWT>"}
```

Si el usuario tiene 2FA activo, la respuesta es `{"requires_2fa": true, "mfa_token": "..."}` y hay que canjear el código TOTP en `POST /api/auth/2fa/verify {"mfa_token","code"}`. **El usuario de servicio de agentes no usa 2FA** para permitir login programático.

### Usuario de servicio

- **`agentes@bylmtm.com`** — perfil `super`, opera la plataforma completa. La credencial se entrega por canal seguro y vive en el secret store del equipo de agentes. Nunca en repos, prompts ni logs.

### Curl de ejemplo (probado en producción)

```bash
TOKEN=$(curl -s -X POST https://crm.lmtmas.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"agentes@bylmtm.com","password":"<SECRET>"}' | jq -r .token)

curl -s https://crm.lmtmas.com/api/admin/overview -H "Authorization: Bearer $TOKEN"
# {"ok":true,"totals":{"companies":9,"users":10,"active_trials":2,"paying":2,"mrr_ars":130000.0},...}
```

---

## 3. Roles y multi-tenancy

| Perfil | Alcance |
|---|---|
| `user` | Operador: conversaciones, contactos/leads, agenda, notas **de su empresa** |
| `admin` | Todo lo de `user` + agente IA, canales, base de conocimiento, usuarios, billing y configuración **de su empresa** |
| `super` | Todo + `/api/admin/*`: todas las empresas, planes, suscripciones, facturas de la plataforma |

**Regla de oro multi-tenant**: el `companyId` viaja dentro del JWT y **todos** los endpoints operativos actúan sobre esa empresa. Un token `super` administra la plataforma vía `/api/admin/*`, pero si necesita operar *dentro* de la empresa de un cliente (crear etapas, conectar canales, configurar su agente IA) debe autenticarse con un usuario **de esa empresa** (creado vía registro o `POST /api/users/`).

---

## 4. Referencia de API

Solo se listan los endpoints relevantes para agentes. Inventario completo: `GET https://crm.lmtmas.com/api/../openapi.json` (interno) o el código en `services/backend-fastapi/app/api/v1/endpoints/`.

### 4.1 Auth (`/api/auth`)

| Método y path | Body | Devuelve / Notas |
|---|---|---|
| `POST /auth/register` | `{"name","email","password"(≥8),"companyName"}` | **Crea empresa + admin + trial 30 días + KB inicial**. 201 con `{user, token}`. Público. |
| `POST /auth/login` | `{"email","password"}` | `{user, token}` o `{requires_2fa, mfa_token}` |
| `GET /auth/me` | — | Usuario del token |
| `POST /auth/refresh` | cookie httpOnly | Nuevo token (uso del frontend; los agentes re-loguean) |
| `POST /auth/forgot-password` / `reset-password` | `{"email"}` / `{"token","password"}` | Reset por email |
| `POST /auth/2fa/*` | setup / enable / disable / verify / status | TOTP (Google Authenticator) |

### 4.2 Usuarios (`/api/users`) — token admin de la empresa

| | |
|---|---|
| `GET /users/` | Lista usuarios de la empresa |
| `POST /users/` | `{"name","email","password","profile":"user"\|"admin"}` → 201 |

No hay DELETE de usuarios por API (decisión deliberada).

### 4.3 Contactos / Leads (`/api/contacts`)

| | |
|---|---|
| `GET /contacts/` | Lista (leads = contactos) |
| `POST /contacts/` | `{"name","number","email?","source?","leadStatus?","assignedUserId?"}` |
| `PUT /contacts/{id}` | Cualquier campo: `name, number, email, leadStatus, assignedUserId, tags:[ids], progress_tags:[str], business_type, needs, inactivityMinutes` |
| `DELETE /contacts/{id}` | **Prohibido para agentes** (ver §8) |

- **Asignar lead a un operador**: `PUT /contacts/{id}` con `{"assignedUserId": <user_id>}`.
- **Campos custom**: no existen como feature. Alternativas soportadas: `tags` (etiquetas con id, CRUD en `/api/tags/`), `progress_tags` (strings libres), `business_type` y `needs` (texto).
- `leadStatus`: `new | engaged | warm | hot | customer | lost`.

### 4.4 Pipeline Kanban (`/api/pipeline`)

| | |
|---|---|
| `GET /pipeline/stages` | Etapas de la empresa (id, name, color, position, is_won) |
| `GET /pipeline/board` | Tablero completo: etapas + leads en cada una |
| `POST /pipeline/stages` | `{"name","color?"}` |
| `PUT /pipeline/stages/{id}` | `{"name?","color?","is_won?"}` |
| `DELETE /pipeline/stages/{id}` | Borra etapa (los leads pasan a la primera) |
| `PUT /pipeline/reorder` | `{"stage_ids":[3,1,2]}` |
| `PUT /pipeline/leads/{contact_id}/stage` | `{"stage_id": N}` — mover lead |

El pipeline también se mueve **solo**: la IA actualiza etapa y score según la conversación.

### 4.5 Canales Meta (`/api/channels`) — token admin de la empresa

| | |
|---|---|
| `GET /channels` | Canales de la empresa (incluye `verify_token`) |
| `POST /channels/discover` | `{"access_token":"<token Meta>"}` → **detecta todos los activos**: números WhatsApp (con nombre y calidad), cuentas IG, páginas FB, con flag `already_connected`, tipo de token y vencimiento. **Usar siempre este flujo primero.** |
| `POST /channels` | `{"channel_type":"whatsapp"\|"instagram"\|"messenger", "name", "external_id", "access_token", "app_secret?"}` |
| `PUT /channels/{id}` | Actualizar nombre/token/app_secret |
| `POST /channels/{id}/test` | Valida el token contra Graph API → `{"ok",data\|error}` |
| `GET /channels/health` | Salud de tokens de todos los canales (cache 60s) |
| `DELETE /channels/{id}` | Desactiva (soft) — **requiere OK humano** |

**Flujo completo para conectar WhatsApp a un cliente** (§5.2).

### 4.6 Agente IA (`/api/ai/agents` y afines) — token admin de la empresa

| | |
|---|---|
| `GET /ai/agents` | Agentes de la empresa (1 activo por vez) |
| `POST /ai/agents` | `{"name","persona","welcomeMsg?","offhoursMsg?","farewellMsg?","businessHoursJson?","funnelStagesJson?","isActive":true}` — activar uno desactiva el resto |
| `PUT /ai/agents/{id}` | Campos parciales. **No enviar `model`** salvo intención explícita (pisaría un fine-tuned) |
| `POST /ai/agents/test-chat` | `{"message","history":[{fromMe,body}],"slots":{},"conversationState":"new"}` → **dry-run del pipeline REAL** (busca en Tokko de verdad, no persiste nada, no envía nada). Devuelve `reply, slots, conversationState, toolCalls` — reenviar `slots`/`conversationState` en el siguiente turno para probar multi-turno. |
| `GET /ai/persona-templates` | Plantillas de persona listas para usar |
| `GET/POST/PUT/DELETE /ai/kb/documents` | Base de conocimiento de la empresa (`{"title","category","content"}`) |
| `POST /ai/rag/search` | `{"query","limit"}` — probar qué recupera el RAG |
| `POST /ai/tickets/{id}/toggle-bot` | `{"botEnabled":bool,"humanOverride":bool}` — pausar bot en una conversación |

### 4.7 Conversaciones, agenda y demás operativos

| | |
|---|---|
| `GET /conversations/` · `PUT /conversations/{id}` | Bandeja de conversaciones |
| `GET/POST /ai/appointments` · `PUT /ai/appointments/{id}` | Citas (`{"contactId","startsAt"ISO,"durationMin","serviceType","notes","sendConfirmation"}`); status `scheduled|completed|cancelled`. Recordatorios 24h/1h automáticos |
| `GET/POST/PUT/DELETE /ai/notes` | Notas internas por ticket/contacto |
| `GET/POST/PUT/DELETE /api/tags/` | Etiquetas |
| `GET/POST/PUT/DELETE /api/saved-replies` | Respuestas rápidas |
| `GET /ai/funnel/stats` · `GET /ai/reports/attribution` | Métricas |
| `GET/POST/PUT/DELETE /api/webhooks/` | Webhooks salientes de la empresa (notificaciones a sistemas externos) |
| `POST /api/integrations/leads` | Alta de lead desde sistemas externos |
| `GET /api/integrations/tokko/status` · `POST .../tokko/properties/search` | Integración Tokko de la empresa |

### 4.8 Billing (`/api/billing`) — token admin de la empresa

| | |
|---|---|
| `GET /billing/plans` | Planes públicos (excluye ocultos como Enterprise) |
| `GET /billing/current` | Plan, límites, uso del mes y suscripción (`status`, `trialEndsAt`) |
| `POST /billing/checkout` | `{"planCode"}` → `{"checkoutUrl"}` de MercadoPago |
| `POST /billing/mp-webhook` | Webhook MP (firma validada). Pago aprobado → activa suscripción + **emite factura ARCA** |

### 4.9 Administración de plataforma (`/api/admin`) — SOLO perfil `super`

| | |
|---|---|
| `GET /admin/overview` | Totales: empresas, usuarios, trials activos, pagando, MRR + uso del mes |
| `GET /admin/companies` | Todas las empresas: plan, estado, trial restante, uso, usuarios, canales, bypass |
| `PUT /admin/companies/{id}/subscription` | `{"planCode"?, "status"?("trialing"\|"active"\|"past_due"\|"canceled"), "extendTrialDays"?, "billingBypass"?}` |
| `PUT /admin/companies/{id}/active` | `{"active": false}` suspende la empresa |
| `GET /admin/plans` · `POST /admin/plans` · `PUT /admin/plans/{code}` | CRUD de planes. Campos: `code, name, monthlyPriceArs, limitsJson (objeto: conversations/users/ai_replies/channels/hidden/one_time), featuresJson (lista), active`. `hidden:true` = solo asignable por admin (Enterprise) |
| `GET /admin/invoices` | Facturas ARCA (CAE, número, estado) |
| `POST /admin/arca/dummy` | Test de conectividad ARCA (FEDummy + WSAA si hay certificado) |

### 4.10 Webhooks entrantes (para referencia, no los llaman los agentes)

| | |
|---|---|
| `GET/POST /webhooks/meta` | Webhook unificado Meta (WhatsApp/IG/Messenger). Verificación GET con `verify_token` de la empresa; POST validado por firma HMAC (`x-hub-signature-256`) con app_secret por canal |
| `GET /health` · `/health/deep` | Monitoreo |

---

## 5. Flujos end-to-end

### 5.1 Onboarding completo de un cliente nuevo

```
1. POST /api/auth/register  {name, email, password, companyName}
   → empresa + admin + trial 30 días. Guardar el token devuelto (token del CLIENTE).
2. Con ese token: POST /api/channels/discover {access_token del negocio}
   → elegir número de WhatsApp / IG / página.
3. POST /api/channels {...} por cada activo elegido → anotar verify_token.
4. En Meta Developers (manual, humano): configurar webhook
   https://crm.lmtmas.com/webhooks/meta + verify_token.
5. POST /api/channels/{id}/test → confirmar "ok": true.
6. Configurar el agente IA: GET /api/ai/persona-templates → POST /api/ai/agents
   con la persona ajustada al negocio.
7. Cargar la base de conocimiento: PUT /api/ai/kb/documents/{id} sobre las
   plantillas creadas por el registro (horarios, servicios, FAQ).
8. Probar: POST /api/ai/agents/test-chat con 3-4 mensajes típicos de cliente.
9. Entregar credenciales al cliente (email+password) con instrucción de
   cambiar contraseña y activar 2FA en /security.
```

### 5.2 Conectar WhatsApp (detalle del paso 2-5)

El token de Meta ideal es un **token de usuario del sistema** (Business Manager → Usuarios del sistema → generar token con permisos `whatsapp_business_management`, `whatsapp_business_messaging`, `pages_messaging`, `instagram_manage_messages`): no vence. `discover` informa tipo y vencimiento del token que le pases.

### 5.3 Cambiarle el plan a un cliente (super)

```
PUT /api/admin/companies/{id}/subscription {"planCode": "enterprise"}
```
Los límites nuevos rigen al instante. Para un Enterprise a medida: primero configurar el plan en `PUT /api/admin/plans/enterprise` (o crear uno específico con `POST /api/admin/plans`, ej. `enterprise_dunod`).

---

## 6. Modelo de datos (referencia)

PostgreSQL 18, DB `atendechat`. **Solo accesible desde el VPS — los agentes usan la API exclusivamente.** Columnas legacy en camelCase requieren comillas dobles en SQL.

| Tabla | Campos clave | Relaciones |
|---|---|---|
| `companies` | id, name, email, status(bool) | raíz del tenant |
| `users` | id, name, email, "passwordHash"(bcrypt), profile, "companyId", totp_enabled | → companies |
| `contacts` (= leads) | id, name, number, email, "companyId", "leadStatus", lead_score, "assignedUserId"→users, stage_id→lead_stages, channel_id→channels, tags, progress_tags, business_type, needs, psid, igsid | → companies |
| `lead_stages` | id, company_id, name, color, position, is_won | Kanban |
| `channels` | id, company_id, channel_type, external_id, meta_connection_id, config_json{verifyToken,appSecret}, status | → meta_connections |
| `meta_connections` | id, company_id, access_token (**cifrado Fernet**), phone_number_id, page_id | tokens Meta |
| `messages` / `tickets` | conversaciones y su estado (bot_enabled, human_override) | → contacts |
| `ai_agents` | company_id, persona, model, is_active, welcome/offhours/farewell_msg, business_hours_json, ai_config_json | config del bot |
| `kb_documents` / `kb_chunks` | base de conocimiento + embeddings | RAG |
| `appointments` | company_id, contact_id, starts_at, status, notes | agenda |
| `billing_plans` | code(PK), name, monthly_price_usd(**valor en ARS**), limits_json, features_json, active | planes |
| `company_subscriptions` | company_id(PK), plan_code, status, period_end | límites vigentes |
| `subscriptions` | "companyId", status, "trialEndsAt", "billingBypass" | trial legacy (fuente del enforcement) |
| `usage_counters` | company_id, period_ym, metric_code, metric_value | uso mensual |
| `invoices` | company_id, amount, cbte_nro, cae, cae_vto, status, mp_payment_id | facturas ARCA |

---

## 7. Errores y comportamiento esperado

| Código | Significado | Acción del agente |
|---|---|---|
| 401 | Token vencido/inválido | Re-login y reintentar 1 vez |
| 402 | Suscripción vencida de ESA empresa | Reportar; no reintentar |
| 403 | Sin permisos (rol insuficiente) | No reintentar; revisar qué token usa |
| 404 | Recurso inexistente o de otra empresa | No reintentar |
| 409 | Duplicado (email registrado, canal existente) | Reportar |
| 422 | Body inválido (validación Pydantic) | Corregir el body |
| 429 | Rate limit (login/registro) | Backoff; cachear token |
| 5xx | Error del servidor | 1 reintento con backoff; si persiste, reportar a grow@bylmtm.com |

---

## 8. Reglas de operación para agentes

### Prohibido siempre (ni siquiera con aprobación — lo hace un humano)
- `DELETE` de empresas, usuarios, contactos o canales en producción.
- Tocar credenciales: `.env`, tokens Meta almacenados, certificados ARCA, contraseñas de terceros.
- Acceso directo a la base de datos o SSH al servidor. **Solo API.**
- Cambiar `billingBypass`, suspender empresas o modificar precios de planes existentes.
- Enviar mensajes de WhatsApp/IG/Messenger a contactos reales de clientes.

### Requieren aprobación humana previa (proponer → esperar OK → ejecutar)
- Crear empresa/cliente. Crear usuarios dentro de empresas de clientes.
- Conectar, editar o testear canales de un cliente (POST/PUT /channels).
- Cambiar plan, estado de suscripción o extender trial. Crear planes nuevos.
- Editar persona/configuración del agente IA de un cliente en producción.
- Modificar la base de conocimiento de un cliente activo.

### Libres (sin aprobación)
- **Todos los GET** (lectura completa, incluido `/api/admin/*`).
- `POST /api/ai/agents/test-chat` (dry-run garantizado, no persiste ni envía).
- `POST /api/channels/{id}/test`, `GET /api/channels/health`, `POST /api/admin/arca/dummy`.
- CRUD de etapas del pipeline y asignación de leads a operadores **cuando el cliente lo solicitó explícitamente**.

### Sobre producción
Los agentes operan sobre datos reales de clientes. El esquema de arriba existe por eso: **lectura libre, escritura acotada con OK humano, destrucción prohibida**. Ante la duda, leer y preguntar.

---

## 9. Secretos y su ubicación

| Secreto | Dónde vive |
|---|---|
| Credencial `agentes@bylmtm.com` | Secret store del equipo de agentes (entregada por canal seguro) |
| Tokens Meta de clientes | Cifrados en DB (`meta_connections`); nunca salen por API |
| `.env` del backend (OpenAI, JWT, encryption key, MP, ARCA) | Solo en el VPS; backup manual del propietario |
| Certificado ARCA | `/etc/arca/` en el VPS (cuando se configure) |

**Regla**: ningún secreto en prompts, repos, logs ni tickets. Si un agente encuentra un secreto expuesto, lo reporta a grow@bylmtm.com sin copiarlo.
