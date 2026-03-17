from fastapi import FastAPI

from app.api.v1.endpoints import auth, contacts, conversations, health, messages, users, webhook_whatsapp
from app.core.config import settings

app = FastAPI(title=settings.app_name)

app.include_router(health.router)
app.include_router(auth.router, prefix=settings.api_prefix)
app.include_router(users.router, prefix=settings.api_prefix)
app.include_router(contacts.router, prefix=settings.api_prefix)
app.include_router(conversations.router, prefix=settings.api_prefix)
app.include_router(messages.router, prefix=settings.api_prefix)
app.include_router(webhook_whatsapp.router)


@app.get("/")
def root():
    return {"service": settings.app_name, "env": settings.environment}
