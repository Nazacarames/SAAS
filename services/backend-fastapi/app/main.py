from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.endpoints import (
    admin_routes, ai_routes, auth, billing_routes, contacts, conversations, health, media_routes,
    messages, settings_routes, saved_replies_routes, users,
    webhook_whatsapp, whatsapp_routes, tags_routes,
    channels_routes, comment_automation_routes, integration_routes, menu_bot_routes, meta_webhook_routes, pipeline_routes, webhook_meta, webhooks_routes,
    training,
)
from app.core.config import settings
from app.core.logging_middleware import setup_logging, CorrelationIdMiddleware
from app.services.socketio_handler import sio_app as socketio_app

app = FastAPI(title=settings.app_name)


_reminder_task = None  # keep a strong reference so the task is never GC'd


@app.on_event("startup")
async def _start_appointment_reminders():
    global _reminder_task
    import asyncio
    from app.services.appointment_reminders import reminder_loop
    _reminder_task = asyncio.create_task(reminder_loop())


_reengagement_task = None


@app.on_event("startup")
async def _start_lead_reengagement():
    global _reengagement_task
    import asyncio
    from app.services.lead_reengagement import reengagement_loop
    _reengagement_task = asyncio.create_task(reengagement_loop())


_learning_task = None


@app.on_event("startup")
async def _start_agent_learning():
    global _learning_task
    import asyncio
    from app.services.agent_learning import distill_loop
    _learning_task = asyncio.create_task(distill_loop())


_channel_health_task = None


@app.on_event("startup")
async def _start_channel_health():
    global _channel_health_task
    import asyncio
    from app.services.channel_health import channel_health_loop
    _channel_health_task = asyncio.create_task(channel_health_loop())


_calendar_sync_task = None


@app.on_event("startup")
async def _start_calendar_sync():
    global _calendar_sync_task
    import asyncio
    from app.services.google_calendar import calendar_sync_loop
    _calendar_sync_task = asyncio.create_task(calendar_sync_loop())


@app.on_event("startup")
async def _raise_thread_limit():
    # Sync (def) endpoints run in anyio's threadpool (default 40 threads).
    # Under concurrent panel load that queue becomes the bottleneck before
    # the DB does; 80 matches the DB pool ceiling per worker.
    import anyio
    anyio.to_thread.current_default_thread_limiter().total_tokens = 80


setup_logging()
app.add_middleware(CorrelationIdMiddleware)


# ── Subscription enforcement ─────────────────────────────────────────
# Expired trial / inactive subscription → HTTP 402 on panel API calls.
# Auth, billing (so the user can pay), webhooks and health stay open.
_BILLING_OPEN_PREFIXES = (
    "/health", "/api/auth", "/api/billing", "/webhooks",
    "/api/webhooks", "/api/ai/meta-leads/webhook", "/socket.io",
)


@app.middleware("http")
async def _enforce_subscription(request, call_next):
    path = request.url.path
    if request.method == "OPTIONS" or not path.startswith("/api") or path.startswith(_BILLING_OPEN_PREFIXES):
        return await call_next(request)

    token = ""
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        token = auth[7:]
    if not token:
        token = request.cookies.get("token", "")
    if not token:
        return await call_next(request)  # unauthenticated → endpoint's own 401

    try:
        from jose import jwt as _jwt
        payload = _jwt.decode(token, settings.jwt_secret, algorithms=["HS256"])
        company_id = int(payload.get("companyId") or 0)
    except Exception:
        return await call_next(request)
    if not company_id:
        return await call_next(request)

    from app.services.cache import get_or_set

    def _check():
        from app.core.db import SessionLocal
        from app.services.billing_service import check_subscription_active
        db = SessionLocal()
        try:
            return check_subscription_active(db, company_id)
        finally:
            db.close()

    ok, msg = get_or_set(f"sub_active:{company_id}", 60, _check)
    if not ok:
        from starlette.responses import JSONResponse
        return JSONResponse(status_code=402, content={"detail": msg, "code": "subscription_required"})
    return await call_next(request)

# CORS middleware - restrict origins in production
_is_prod = settings.environment == "production"
_allowed_origins = (
    ["https://crm.lmtmas.com", "https://charlott.ai", "https://www.charlott.ai", "https://login.charlott.ai"]
    if _is_prod
    else ["http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"]
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Socket.IO
app.mount("/socket.io", socketio_app)

# Health
app.include_router(health.router)

# Auth & Users
app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(users.router, prefix=settings.api_prefix)

# Core resources
app.include_router(contacts.router, prefix=settings.api_prefix)
app.include_router(media_routes.router, prefix=settings.api_prefix)
app.include_router(conversations.router, prefix=settings.api_prefix)
app.include_router(messages.router, prefix=settings.api_prefix)
app.include_router(tags_routes.router, prefix=settings.api_prefix)
app.include_router(saved_replies_routes.router)
app.include_router(webhooks_routes.router, prefix=settings.api_prefix)

# WhatsApp
app.include_router(webhook_whatsapp.router)
app.include_router(whatsapp_routes.router, prefix=settings.api_prefix)

# AI
app.include_router(ai_routes.router)
app.include_router(training.router)

# Settings & Billing
app.include_router(settings_routes.router, prefix=settings.api_prefix)
app.include_router(billing_routes.router, prefix=settings.api_prefix)
app.include_router(admin_routes.router, prefix=settings.api_prefix)
app.include_router(channels_routes.router, prefix=settings.api_prefix)
app.include_router(comment_automation_routes.router, prefix=settings.api_prefix)
app.include_router(menu_bot_routes.router, prefix=settings.api_prefix)
app.include_router(pipeline_routes.router, prefix=settings.api_prefix)

# Integrations
app.include_router(integration_routes.router, prefix=settings.api_prefix)
app.include_router(meta_webhook_routes.router, prefix=settings.api_prefix)
app.include_router(webhook_meta.router)


@app.get("/")
def root():
    return {"service": settings.app_name, "env": settings.environment}
