"""AI routes aggregator — includes all sub-routers under /api/ai."""
from fastapi import APIRouter

from app.api.v1.endpoints import (
    agents_routes,
    kb_routes,
    tools_routes,
    meta_routes,
    automation_routes,
)

router = APIRouter(prefix="/api/ai", tags=["ai"])

router.include_router(agents_routes.router)
router.include_router(kb_routes.router)
router.include_router(tools_routes.router)
router.include_router(meta_routes.router)
router.include_router(automation_routes.router)
