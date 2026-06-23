# LMTM CRM

CRM multi-tenant de WhatsApp con IA para equipos comerciales (foco inmobiliario). Centraliza conversaciones de WhatsApp, responde con un agente de IA 24/7 (RAG + base de conocimiento), captura y califica leads de Meta Lead Ads, agenda citas con recordatorios automáticos y mide el funnel comercial.

**Producción:** https://crm.lmtmas.com

---

## Arquitectura

| Capa | Stack |
|---|---|
| Backend | **FastAPI** (Python 3.10), SQLAlchemy + psycopg3, 2 workers uvicorn en `127.0.0.1:4010` |
| Frontend | **React 18** + TypeScript + Vite + Material-UI v5 |
| Base de datos | **PostgreSQL** (multi-tenant, todo scopeado por `company_id`) |
| IA | OpenAI vía orquestador conversacional propio (RAG híbrido + KB por empresa) |
| Mensajería | **WhatsApp Cloud API** (Meta Graph v21) + **Meta Lead Ads** webhooks |
| Infra | VPS + nginx (TLS Let's Encrypt) + systemd |

El backend antiguo en Node.js/Baileys fue **migrado completamente a FastAPI** y removido.

```
.
├── frontend/                     # React + Vite (SPA servida por nginx)
│   └── src/
│       ├── pages/                # Conversations, Contacts, Leads, Agenda,
│       │                         # Reports, Billing, AIAgents, Knowledge, etc.
│       ├── components/           # Sidebar, HealthAlert, etc.
│       ├── context/Auth/         # Auth context
│       ├── layout/MainLayout.tsx
│       └── routes/
├── services/backend-fastapi/     # API FastAPI
│   └── app/
│       ├── api/v1/endpoints/     # auth, conversations, contacts, agents_routes,
│       │                         # billing_routes, settings_routes, health,
│       │                         # webhook_whatsapp, meta_webhook_routes, ...
│       ├── services/             # conversation_orchestrator, knowledge_base,
│       │                         # appointment_reminders, billing_service,
│       │                         # email_service, auth_service, contacts_service
│       ├── schemas/              # Pydantic
│       ├── core/                 # config, db, logging
│       └── main.py
└── deploy.sh                     # Deploy en un comando (VPS)
```

---

## Funcionalidades

- **Conversaciones WhatsApp** con panel de lead: score, etapa, datos capturados, trazabilidad de decisiones del agente y resumen de IA.
- **Agente de IA** configurable por empresa: persona, horarios de atención, mensajes fuera de horario / despedida, RAG sobre base de conocimiento, dry-run de prueba.
- **Meta Lead Ads**: captura automática de leads por webhook (uno por empresa), upsert de contacto y sincronización de nombre.
- **Agenda estilo Calendly**: slots según horario del agente, alta/cancelación de citas, **recordatorios automáticos por WhatsApp** (24 h y 1 h antes).
- **Reportes**: funnel, conversión, fuentes/campañas, motivos de pérdida de leads.
- **Billing**: planes (Starter / Pro / Scale), medición de uso (conversaciones, respuestas IA, mensajes), enforcement de límites y checkout con **MercadoPago**.
- **Auth**: JWT con refresh tokens rotativos, registro de empresa con trial, y **reset de contraseña por email**.
- **Monitoreo**: health checks profundos, verificación diaria de salud de tokens de WhatsApp y banner de alerta en la UI.

---

## Desarrollo local

### Backend (FastAPI)

```bash
cd services/backend-fastapi
python -m venv .venv
# Windows: .venv\Scripts\activate   |   Linux/Mac: source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env   # completar credenciales (ver más abajo)
uvicorn app.main:app --reload --port 4010
```

Tests: `python -m pytest tests/ -v`

### Frontend (React)

```bash
cd frontend
npm install
npm run dev      # desarrollo
npm run build    # build de producción (genera frontend/build/)
```

El frontend usa rutas relativas (`/api`), así que no necesita conocer el dominio.

---

## Variables de entorno (backend `.env`)

```env
ENVIRONMENT=production

# Base de datos
DB_HOST=localhost
DB_PORT=5432
DB_USER=atendechat_user
DB_PASS=********
DB_NAME=atendechat

# JWT
JWT_SECRET=********
JWT_REFRESH_SECRET=********
ACCESS_TOKEN_EXPIRE_MINUTES=15
REFRESH_TOKEN_EXPIRE_DAYS=7

# OpenAI
OPENAI_API_KEY=sk-...

# WhatsApp Cloud / Meta (verify token global; cada empresa puede tener el suyo)
META_WEBHOOK_VERIFY_TOKEN=********
META_APP_SECRET=********

# SMTP (reset de contraseña)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=

# Dominio (emails de reset, back_urls de MercadoPago)
FRONTEND_URL=https://crm.lmtmas.com

# MercadoPago (vacío = checkout deshabilitado)
MP_ACCESS_TOKEN=
```

En producción el `Settings` falla al arrancar si faltan `JWT_SECRET`, `JWT_REFRESH_SECRET` o `DB_PASS`.

---

## Webhooks de Meta

| Producto | Callback URL | Verify token |
|---|---|---|
| WhatsApp Cloud (todas las empresas) | `https://crm.lmtmas.com/api/whatsapp-cloud/webhook` | global o `waCloudVerifyToken` por empresa; rutea por `phone_number_id` |
| Meta Lead Ads (por empresa) | `https://crm.lmtmas.com/api/ai/meta-leads/webhook/{company_id}` | `metaLeadAdsWebhookVerifyToken` de cada empresa |

---

## Despliegue (VPS)

El repo vive en `/home/deploy/atendechat` (rama `main`). Deploy en un comando:

```bash
./deploy.sh
```

El script hace `git pull origin main`, instala dependencias, buildea el frontend, lo publica, reinicia el servicio y verifica el health.

Operación manual:

```bash
systemctl restart charlott-fastapi      # backend FastAPI
cd frontend && npm run build            # nginx sirve desde frontend/build
systemctl reload nginx
```

### Health checks

```bash
curl https://crm.lmtmas.com/health              # liveness
curl https://crm.lmtmas.com/health/deep         # + base de datos
curl https://crm.lmtmas.com/health/whatsapp-tokens   # estado de tokens Meta
```

### Tareas programadas (systemd timers)

- `pg-backup-atendechat.timer` — backup diario de Postgres (gzip, retención 14 días) en `/var/backups/postgres`.
- `wa-token-check.timer` — verificación diaria de salud de tokens de WhatsApp (loguea warnings).

### SSL

Certificado de Let's Encrypt con renovación automática. Para (re)emitir tras cambios de dominio: `/usr/local/bin/setup-crm-ssl.sh`.

---

## Notas operativas

- El servicio `charlott-fastapi` corre con `Restart=always`.
- nginx sirve el frontend directamente desde `frontend/build` (el build actualiza lo servido).
- Todo el acceso a datos está scopeado por `company_id` — verificar siempre el tenant en cambios al backend.

---

Software privado y propietario.
