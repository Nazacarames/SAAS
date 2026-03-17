from fastapi import FastAPI

from app.api.v1.endpoints import ai_routes, auth, billing_routes, contacts, conversations, health, messages, saved_replies_routes, settings_routes, users, webhook_whatsapp, whatsapp_routes
from app.core.config import settings

app = FastAPI(title=settings.app_name)

app.include_router(health.router)
app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(users.router, prefix=settings.api_prefix)
app.include_router(contacts.router, prefix=settings.api_prefix)
app.include_router(conversations.router, prefix=settings.api_prefix)
app.include_router(messages.router, prefix=settings.api_prefix)
app.include_router(webhook_whatsapp.router)
app.include_router(ai_routes.router)
app.include_router(whatsapp_routes.router)
app.include_router(saved_replies_routes.router)
app.include_router(settings_routes.router)
app.include_router(billing_routes.router)


@app.get("/")
def root():
    return {"service": settings.app_name, "env": settings.environment}
