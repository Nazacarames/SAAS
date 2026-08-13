"""Seguimiento al lead que fue derivado a un asesor.

A las N horas del último mensaje del cliente se le pregunta si pudo hablar con
el asesor. Según lo que conteste:
  - no pudo (o contesta algo que no se puede interpretar) → se deriva de nuevo,
    con aviso al asesor. Ante la duda se deriva: dejar colgado a alguien que ya
    esperó es peor que molestar a un asesor de más.
  - sí pudo → se agradece y se cierra.

Solo aplica a leads con la etiqueta de derivado, y solo dentro de las 24 h del
último mensaje del cliente: fuera de esa ventana Meta no deja mandar texto
libre y la pregunta tendría que ser una plantilla aprobada.

Config por empresa en ai_agents.ai_config_json:
  "followup_asesor": {
    "enabled": true,
    "hours": 3,
    "send_hour_start": 9,
    "send_hour_end": 20,
    "timezone": "America/Argentina/Buenos_Aires",
    "pregunta": "...",          // opcional, texto de la consulta
    "despedida": "...",         // opcional, cierre cuando sí pudo hablar
    "rederivacion": "..."       // opcional, respuesta cuando no pudo
  }
"""

import asyncio
import json
import logging
import re
import unicodedata
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.core.db import SessionLocal

log = logging.getLogger("app.followup")

SCAN_INTERVAL_SECONDS = 600
MAX_POR_EMPRESA = 25
TZ_DEFECTO = "America/Argentina/Buenos_Aires"

TAG_DERIVADO = "derivado_asesor"
TAG_PENDIENTE = "seguimiento_pendiente"
TAG_HECHO = "seguimiento_hecho"

PREGUNTA = ("Hola{nombre}! Te escribimos para saber cómo te fue: ¿pudiste hablar con el asesor "
            "por tu consulta? Respondeme *sí* o *no* y seguimos.")
DESPEDIDA = ("¡Genial! Cualquier cosa que necesites escribinos por acá. ¡Gracias por elegirnos!")
REDERIVACION = ("Perdón por la demora. Ya avisé al asesor para que te contacte a la brevedad.")


# ── configuración ─────────────────────────────────────────────────
def cfg_de(db, company_id: int) -> dict:
    row = db.execute(
        text("SELECT ai_config_json FROM ai_agents WHERE company_id = :c AND is_active = true "
             "ORDER BY id DESC LIMIT 1"),
        {"c": company_id},
    ).scalar()
    try:
        return (json.loads(row or "{}") or {}).get("followup_asesor") or {}
    except Exception:
        return {}


def _en_horario(cfg: dict) -> bool:
    try:
        ini, fin = int(cfg.get("send_hour_start", 9)), int(cfg.get("send_hour_end", 20))
    except (TypeError, ValueError):
        ini, fin = 9, 20
    try:
        hora = datetime.now(ZoneInfo(str(cfg.get("timezone") or TZ_DEFECTO))).hour
    except Exception:
        hora = datetime.now(ZoneInfo(TZ_DEFECTO)).hour
    if ini == fin:
        return True
    return ini <= hora < fin if ini < fin else (hora >= ini or hora < fin)


# ── interpretación de la respuesta ────────────────────────────────
def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9 ]", " ", s.lower())


_NEGATIVAS = ("no", "todavia no", "aun no", "nadie", "ninguno", "nunca", "negativo",
              "no pude", "no me contactaron", "no me llamaron", "no me escribieron",
              "sigo esperando", "esperando", "nada", "tampoco", "ni")
_POSITIVAS = ("si", "sip", "claro", "obvio", "correcto", "afirmativo", "dale",
              "ya hable", "hable", "me contactaron", "me llamaron", "me escribieron",
              "me atendieron", "todo bien", "perfecto", "listo", "resuelto",
              "solucionado", "gracias", "ya esta", "excelente", "buenisimo")


def interpretar(texto: str) -> str:
    """'pudo' | 'no_pudo'. La negativa gana: 'sí pero no me resolvieron' es
    alguien que sigue necesitando un asesor."""
    frase = " ".join(_norm(texto).split())
    palabras = set(frase.split())
    if any((f in palabras if " " not in f else f in frase) for f in _NEGATIVAS):
        return "no_pudo"
    if any((f in palabras if " " not in f else f in frase) for f in _POSITIVAS):
        return "pudo"
    return "no_pudo"  # ante la duda, que lo atienda una persona


# ── etiquetas ─────────────────────────────────────────────────────
def _tags(db, contact_id: int, agregar: list[str] = (), quitar: list[str] = ()) -> None:
    db.execute(
        text("UPDATE contacts SET progress_tags = (SELECT ARRAY(SELECT DISTINCT t FROM unnest("
             "  COALESCE(progress_tags, ARRAY[]::text[]) || CAST(:add AS text[])) AS t "
             "  WHERE t <> ALL(CAST(:del AS text[])))), \"updatedAt\" = NOW() WHERE id = :i"),
        {"add": list(agregar), "del": list(quitar), "i": contact_id},
    )
    db.commit()


# ── envío de la consulta ──────────────────────────────────────────
def _candidatos(db, company_id: int, horas: int) -> list:
    return db.execute(
        text('''
            -- psid/igsid: en Messenger e Instagram el destinatario no es un
            -- numero. Sin estos campos el envio moria con "no_recipient" y el
            -- lead se reintentaba cada 10 minutos sin salir nunca.
            SELECT c.id, c.name, c.number, c.psid, c.igsid, c.channel_id, m.last_at
            FROM contacts c
            JOIN LATERAL (
                SELECT MAX(msg."createdAt") AS last_at FROM messages msg
                WHERE msg."contactId" = c.id AND msg."fromMe" = false
            ) m ON TRUE
            WHERE c."companyId" = :cid
              AND COALESCE(c."isGroup", false) = false
              AND :tag_der = ANY(COALESCE(c.progress_tags, ARRAY[]::text[]))
              AND NOT (:tag_pen = ANY(COALESCE(c.progress_tags, ARRAY[]::text[])))
              AND NOT (:tag_ok  = ANY(COALESCE(c.progress_tags, ARRAY[]::text[])))
              AND COALESCE(c."leadStatus", 'new') NOT IN ('customer', 'lost')
              AND m.last_at IS NOT NULL
              AND m.last_at <= NOW() - (:horas || ' hours')::interval
              -- fuera de las 24 h Meta no acepta texto libre: el lead deja de
              -- ser candidato solo, sin quedar reintentándose para siempre
              AND m.last_at > NOW() - INTERVAL '23 hours'
            ORDER BY m.last_at
            LIMIT :lim
        '''),
        {"cid": company_id, "tag_der": TAG_DERIVADO, "tag_pen": TAG_PENDIENTE,
         "tag_ok": TAG_HECHO, "horas": horas, "lim": MAX_POR_EMPRESA},
    ).mappings().all()


def _reclamar(db, contact_id: int) -> bool:
    """Se pone la etiqueta ANTES de enviar. El loop corre en los dos workers de
    uvicorn: sin este reclamo atómico, los dos leen al mismo candidato y el
    cliente recibe la consulta duplicada. Gana el que logra escribir la
    etiqueta; si después falla el envío, se suelta para reintentar."""
    n = db.execute(
        text("UPDATE contacts SET progress_tags = (SELECT ARRAY(SELECT DISTINCT unnest("
             "  COALESCE(progress_tags, ARRAY[]::text[]) || ARRAY[:tag]))) "
             "WHERE id = :i AND NOT (:tag = ANY(COALESCE(progress_tags, ARRAY[]::text[])))"),
        {"tag": TAG_PENDIENTE, "i": contact_id},
    ).rowcount
    db.commit()
    return bool(n)


async def _enviar(db, company_id: int, lead: dict, cuerpo: str) -> bool:
    from app.services.channels.sender import send_via_channel
    from app.api.v1.endpoints.webhook_whatsapp import save_message
    r = await send_via_channel(db, company_id=company_id, contact=dict(lead),
                               recipient_id=str(lead.get("number") or "") or None, text_body=cuerpo)
    if not getattr(r, "ok", False):
        log.info("followup: no se pudo enviar a contacto %s (%s)", lead["id"], getattr(r, "error", ""))
        return False
    try:
        save_message(db, int(lead["id"]), cuerpo, True, company_id)
    except Exception:
        db.rollback()
    return True


async def _scan() -> None:
    db = SessionLocal()
    try:
        empresas = [r[0] for r in db.execute(
            text("SELECT DISTINCT company_id FROM ai_agents WHERE is_active = true")).all()]
        for company_id in empresas:
            cfg = cfg_de(db, company_id)
            if not cfg.get("enabled"):
                continue
            if not _en_horario(cfg):
                continue
            try:
                horas = max(1, int(cfg.get("hours", 3)))
            except (TypeError, ValueError):
                horas = 3
            pregunta = str(cfg.get("pregunta") or PREGUNTA)
            for lead in _candidatos(db, company_id, horas):
                if not _reclamar(db, int(lead["id"])):
                    continue
                nombre = str(lead["name"] or "").strip().split(" ")[0]
                cuerpo = pregunta.replace("{nombre}", (" " + nombre) if nombre else "")
                if await _enviar(db, company_id, dict(lead), cuerpo):
                    log.info("followup: consulta enviada company=%s contacto=%s", company_id, lead["id"])
                else:
                    _tags(db, int(lead["id"]), quitar=[TAG_PENDIENTE])
    except Exception as e:
        log.error("followup scan: %s", str(e)[:200])
        db.rollback()
    finally:
        db.close()


async def followup_loop() -> None:
    log.info("followup de asesor: loop iniciado (cada %ss)", SCAN_INTERVAL_SECONDS)
    while True:
        try:
            await _scan()
        except Exception as e:
            log.error("followup loop: %s", str(e)[:200])
        await asyncio.sleep(SCAN_INTERVAL_SECONDS)


# ── respuesta del cliente ─────────────────────────────────────────
async def handle_reply(db, company_id: int, contact_id: int, texto: str) -> dict | None:
    """Si el contacto tiene una consulta de seguimiento pendiente, resuelve acá
    y devuelve el resultado. Si no, devuelve None y el mensaje sigue su curso.

    Corre ANTES del corte por ai_paused: el lead derivado está pausado justamente
    porque lo atiende una persona, y sin esto su respuesta no se leería nunca.
    """
    fila = db.execute(
        text('SELECT id, name, number, psid, igsid, channel_id, progress_tags FROM contacts '
             'WHERE id = :i AND "companyId" = :c'),
        {"i": contact_id, "c": company_id},
    ).mappings().first()
    if not fila or TAG_PENDIENTE not in (fila["progress_tags"] or []):
        return None

    cfg = cfg_de(db, company_id)
    respuesta = interpretar(texto)
    _tags(db, contact_id, agregar=[TAG_HECHO], quitar=[TAG_PENDIENTE])

    if respuesta == "pudo":
        cuerpo = str(cfg.get("despedida") or DESPEDIDA)
        await _enviar(db, company_id, dict(fila), cuerpo)
        log.info("followup: contacto %s pudo hablar, se cierra", contact_id)
        return {"ok": True, "resultado": "pudo", "respuesta": cuerpo}

    cuerpo = str(cfg.get("rederivacion") or REDERIVACION)
    await _enviar(db, company_id, dict(fila), cuerpo)
    try:
        from app.services.handoff import derive_to_advisor
        derive_to_advisor(db, company_id, contact_id,
                          motivo="No pudo hablar con el asesor",
                          resumen=("El cliente contestó «%s» al seguimiento. "
                                   "Necesita que lo contacten." % str(texto or "")[:120]))
    except Exception as e:
        log.warning("followup: no se pudo re-derivar el contacto %s (%s)", contact_id, str(e)[:120])
        db.rollback()
    log.info("followup: contacto %s no pudo hablar, re-derivado", contact_id)
    return {"ok": True, "resultado": "no_pudo", "respuesta": cuerpo}
