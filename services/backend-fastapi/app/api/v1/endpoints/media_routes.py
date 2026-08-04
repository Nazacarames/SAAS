"""Entrega de los adjuntos guardados.

Con sesión, no como archivos públicos: son fotos que manda el cliente
(presupuestos, comprobantes, a veces un DNI) y el nombre aleatorio del archivo
no alcanza como control de acceso. Cada empresa solo llega a lo suyo.
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from app.api.deps import get_current_user_payload
from app.services.media_store import resolve_path

router = APIRouter(prefix="/media", tags=["media"])


@router.get("/{company_id}/{filename}")
def get_media(
    company_id: int,
    filename: str,
    payload: dict = Depends(get_current_user_payload),
):
    if int(payload.get("companyId") or 0) != int(company_id) and payload.get("profile") != "super":
        raise HTTPException(status_code=403, detail="Sin acceso a este archivo")
    path = resolve_path(company_id, filename)
    if not path:
        raise HTTPException(status_code=404, detail="Archivo no encontrado")
    return FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})
