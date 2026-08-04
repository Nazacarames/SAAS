"""Descarga y guardado de los adjuntos que manda el cliente.

Meta no manda el archivo en el webhook: manda un id. Y la URL que se obtiene
con ese id vive cinco minutos y necesita el token del canal, así que no se puede
guardar el link y mostrarlo después. Hay que bajar el archivo en el momento y
servirlo desde acá; si no, en el panel solo queda "[image message]".

Los archivos van a MEDIA_ROOT/{empresa}/{nombre aleatorio}. El nombre no se
puede adivinar, pero igual se sirven por un endpoint con sesión: son fotos de
clientes (presupuestos, DNI, comprobantes), no material público.
"""
import logging
import mimetypes
import os
import secrets
from pathlib import Path

import httpx

log = logging.getLogger("app.media")

GRAPH = "https://graph.facebook.com/v21.0"
MEDIA_ROOT = Path(os.getenv("MEDIA_ROOT", "/home/deploy/atendechat/media"))
MAX_BYTES = 25 * 1024 * 1024  # los límites de Meta ya están por debajo

_EXT = {
    "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif",
    "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "audio/mp4": ".m4a", "audio/amr": ".amr",
    "video/mp4": ".mp4", "video/3gpp": ".3gp",
    "application/pdf": ".pdf",
}


def _kind(mime: str) -> str:
    m = (mime or "").lower()
    if m.startswith("image/"):
        return "image"
    if m.startswith("audio/"):
        return "audio"
    if m.startswith("video/"):
        return "video"
    return "document"


def download_meta_media(media_id: str, token: str, company_id: int) -> dict:
    """Baja el adjunto de Meta y lo deja guardado.

    Devuelve {"url": "/api/media/...", "mime": ..., "kind": "image"} o {} si falla.
    """
    if not media_id or not token:
        return {}
    try:
        H = {"Authorization": "Bearer %s" % token}
        meta = httpx.get("%s/%s" % (GRAPH, media_id), headers=H, timeout=25)
        if meta.status_code != 200:
            log.warning("media %s: no se pudo resolver (%s)", media_id, meta.text[:120])
            return {}
        info = meta.json()
        url = info.get("url") or ""
        mime = (info.get("mime_type") or "").split(";")[0].strip()
        if not url:
            return {}

        # la URL del CDN también pide el token del canal
        blob = httpx.get(url, headers=H, timeout=60, follow_redirects=True)
        if blob.status_code != 200:
            log.warning("media %s: descarga fallida (%s)", media_id, blob.status_code)
            return {}
        data = blob.content
        if not data or len(data) > MAX_BYTES:
            return {}

        ext = _EXT.get(mime) or mimetypes.guess_extension(mime or "") or ".bin"
        carpeta = MEDIA_ROOT / str(company_id)
        carpeta.mkdir(parents=True, exist_ok=True)
        nombre = secrets.token_urlsafe(24).replace("-", "_") + ext
        (carpeta / nombre).write_bytes(data)
        return {"url": "/api/media/%s/%s" % (company_id, nombre), "mime": mime, "kind": _kind(mime)}
    except Exception as e:
        log.warning("media %s: %s", media_id, str(e)[:150])
        return {}


def download_direct_url(url: str, company_id: int) -> dict:
    """Igual que la anterior pero para Instagram/Messenger, que en vez de un id
    mandan una URL firmada del CDN. Esa URL vence, por eso se copia acá."""
    if not url:
        return {}
    try:
        r = httpx.get(url, timeout=60, follow_redirects=True)
        if r.status_code != 200 or not r.content or len(r.content) > MAX_BYTES:
            return {}
        mime = (r.headers.get("content-type") or "").split(";")[0].strip()
        ext = _EXT.get(mime) or mimetypes.guess_extension(mime or "") or ".bin"
        carpeta = MEDIA_ROOT / str(company_id)
        carpeta.mkdir(parents=True, exist_ok=True)
        nombre = secrets.token_urlsafe(24).replace("-", "_") + ext
        (carpeta / nombre).write_bytes(r.content)
        return {"url": "/api/media/%s/%s" % (company_id, nombre), "mime": mime, "kind": _kind(mime)}
    except Exception as e:
        log.warning("media directa: %s", str(e)[:150])
        return {}


def resolve_path(company_id: int, filename: str) -> Path | None:
    """Ruta en disco de un archivo ya guardado, o None.

    Se rechaza cualquier nombre con separadores: sin esto un pedido con ../..
    saldría del directorio de media y podría leer archivos del servidor."""
    if not filename or "/" in filename or "\\" in filename or ".." in filename:
        return None
    p = (MEDIA_ROOT / str(int(company_id)) / filename).resolve()
    try:
        if not str(p).startswith(str(MEDIA_ROOT.resolve())):
            return None
    except Exception:
        return None
    return p if p.is_file() else None
