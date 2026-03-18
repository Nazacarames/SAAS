from fastapi import FastAPI

from app.api.v1.endpoints import (
    ai_routes, auth, billing_routes, contacts, conversations, health, 
    messages, saved_replies_routes, settings_routes, users, 
    webhook_whatsapp, whatsapp_routes, tags_routes, 
    integration_routes, meta_webhook_routes, webhooks_routes
)
from app.core.config import settings

app = FastAPI(title=settings.app_name)

# Health
app.include_router(health.router)

# Auth & Users
app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(users.router, prefix=settings.api_prefix)

# Core resources
app.include_router(contacts.router, prefix=settings.api_prefix)
app.include_router(conversations.router, prefix=settings.api_prefix)
app.include_router(messages.router, prefix=settings.api_prefix)
app.include_router(tags_routes.router, prefix=settings.api_prefix)
app.include_router(webhooks_routes.router, prefix=settings.api_prefix)

# WhatsApp
app.include_router(webhook_whatsapp.router)
app.include_router(whatsapp_routes.router, prefix=settings.api_prefix)

# AI
app.include_router(ai_routes.router)

# Settings & Billing
app.include_router(saved_replies_routes.router, prefix=settings.api_prefix)
app.include_router(settings_routes.router, prefix=settings.api_prefix)
app.include_router(billing_routes.router, prefix=settings.api_prefix)

# Integrations
app.include_router(integration_routes.router)
app.include_router(meta_webhook_routes.router)


@app.get("/")
def root():
    return {"service": settings.app_name, "env": settings.environment}
