"""Sincronización de agenda con Google Calendar, en las dos direcciones.

  CRM  → Google : al crear/cambiar/cancelar una cita se crea, mueve o borra el
                  evento en el calendario conectado.
  Google → CRM  : un loop lee los cambios del calendario y los baja a la agenda,
                  así una cita que el asesor agenda desde su celular dispara los
                  recordatorios de WhatsApp igual que una cargada acá.

Cómo se evita el ida y vuelta infinito: cada evento que creamos lleva el id de
la cita en extendedProperties.private.crm_appointment_id, y cada cita guarda el
id del evento. Al bajar cambios, un evento nuestro actualiza SU cita en vez de
crear una nueva.

Para bajar cambios se usa syncToken (lista incremental). No se usan las
notificaciones push de Google: necesitan renovar el canal cada semana y no
aportan nada acá, un sondeo de dos minutos alcanza de sobra para una agenda.
"""
import json
import logging
import re
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.services.crypto import decrypt, encrypt

log = logging.getLogger("app.calendar")

OAUTH_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
OAUTH_TOKEN = "https://oauth2.googleapis.com/token"
API = "https://www.googleapis.com/calendar/v3"
SCOPES = "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email"
TZ = "America/Argentina/Buenos_Aires"


def _cfg() -> dict:
    import os
    return {
        "client_id": os.getenv("GOOGLE_CLIENT_ID", "").strip(),
        "client_secret": os.getenv("GOOGLE_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.getenv("GOOGLE_REDIRECT_URI", "https://crm.lmtmas.com/api/integrations/google/callback").strip(),
    }


def is_configured() -> bool:
    c = _cfg()
    return bool(c["client_id"] and c["client_secret"])


# ── OAuth ────────────────────────────────────────────────────────────

def auth_url(state: str) -> str:
    from urllib.parse import urlencode
    c = _cfg()
    return OAUTH_AUTH + "?" + urlencode({
        "client_id": c["client_id"],
        "redirect_uri": c["redirect_uri"],
        "response_type": "code",
        "scope": SCOPES,
        "access_type": "offline",     # sin esto no llega refresh_token
        "prompt": "consent",          # fuerza refresh_token aunque ya haya dado permiso antes
        "include_granted_scopes": "true",
        "state": state,
    })


def exchange_code(code: str) -> dict:
    c = _cfg()
    r = httpx.post(OAUTH_TOKEN, timeout=30, data={
        "code": code, "client_id": c["client_id"], "client_secret": c["client_secret"],
        "redirect_uri": c["redirect_uri"], "grant_type": "authorization_code"})
    if r.status_code != 200:
        raise RuntimeError("Google rechazó el código: %s" % r.text[:200])
    return r.json()


def _email_of(access_token: str) -> str:
    try:
        r = httpx.get("https://www.googleapis.com/oauth2/v2/userinfo", timeout=15,
                      headers={"Authorization": "Bearer %s" % access_token})
        return (r.json() or {}).get("email", "") if r.status_code == 200 else ""
    except Exception:
        return ""


def save_connection(db: Session, company_id: int, user_id, tokens: dict, calendar_id: str = "primary") -> dict:
    access = tokens.get("access_token") or ""
    refresh = tokens.get("refresh_token") or ""
    expires = datetime.now(timezone.utc) + timedelta(seconds=int(tokens.get("expires_in") or 3600))
    email = _email_of(access)

    prev = db.execute(
        text("SELECT id, refresh_token FROM calendar_connections "
             "WHERE company_id = :c AND user_id IS NOT DISTINCT FROM :u AND provider = 'google'"),
        {"c": company_id, "u": user_id},
    ).mappings().first()
    # Google manda refresh_token solo la primera vez: si reconecta, se conserva
    if not refresh and prev:
        refresh = decrypt(prev["refresh_token"]) if prev["refresh_token"] else ""

    if prev:
        db.execute(text("""UPDATE calendar_connections SET access_token = :a, refresh_token = :r,
                           token_expires_at = :e, email = :m, calendar_id = :cal, sync_token = '',
                           last_error = '', updated_at = NOW() WHERE id = :id"""),
                   {"a": encrypt(access), "r": encrypt(refresh), "e": expires, "m": email,
                    "cal": calendar_id, "id": prev["id"]})
        conn_id = prev["id"]
    else:
        conn_id = db.execute(text("""INSERT INTO calendar_connections
                           (company_id, user_id, provider, email, calendar_id, access_token, refresh_token, token_expires_at)
                           VALUES (:c, :u, 'google', :m, :cal, :a, :r, :e) RETURNING id"""),
                             {"c": company_id, "u": user_id, "m": email, "cal": calendar_id,
                              "a": encrypt(access), "r": encrypt(refresh), "e": expires}).scalar()
    db.commit()
    return {"id": conn_id, "email": email}


def _token(db: Session, conn: dict) -> str:
    """Access token vivo. Lo renueva con el refresh_token si venció."""
    exp = conn.get("token_expires_at")
    access = decrypt(conn.get("access_token")) if conn.get("access_token") else ""
    if access and exp and exp > datetime.now(timezone.utc) + timedelta(minutes=2):
        return access

    refresh = decrypt(conn.get("refresh_token")) if conn.get("refresh_token") else ""
    if not refresh:
        return access
    c = _cfg()
    r = httpx.post(OAUTH_TOKEN, timeout=30, data={
        "refresh_token": refresh, "client_id": c["client_id"],
        "client_secret": c["client_secret"], "grant_type": "refresh_token"})
    if r.status_code != 200:
        db.execute(text("UPDATE calendar_connections SET last_error = :e, updated_at = NOW() WHERE id = :i"),
                   {"e": ("No se pudo renovar el acceso a Google: %s" % r.text[:150]), "i": conn["id"]})
        db.commit()
        return ""
    j = r.json()
    access = j.get("access_token") or ""
    db.execute(text("UPDATE calendar_connections SET access_token = :a, token_expires_at = :e, "
                    "last_error = '', updated_at = NOW() WHERE id = :i"),
               {"a": encrypt(access), "e": datetime.now(timezone.utc) + timedelta(seconds=int(j.get("expires_in") or 3600)),
                "i": conn["id"]})
    db.commit()
    return access


def _connection_for(db: Session, company_id: int) -> dict | None:
    """La conexión que usa la empresa. Si hay varias (una por asesor), se usa la
    de la empresa (user_id NULL) y si no la primera cargada."""
    row = db.execute(
        text("SELECT * FROM calendar_connections WHERE company_id = :c AND provider = 'google' "
             "ORDER BY (user_id IS NULL) DESC, id LIMIT 1"),
        {"c": company_id},
    ).mappings().first()
    return dict(row) if row else None


# ── CRM → Google ─────────────────────────────────────────────────────

def _event_body(appt: dict) -> dict:
    titulo = (appt.get("title") or "").strip() or ("Cita: %s" % (appt.get("contact_name") or "cliente"))
    desc = []
    if appt.get("contact_name"):
        desc.append("Cliente: %s" % appt["contact_name"])
    if appt.get("contact_number"):
        desc.append("WhatsApp: +%s" % appt["contact_number"])
    if appt.get("notes"):
        desc.append(str(appt["notes"]))
    desc.append("— Agendado desde el CRM")
    body = {
        "summary": titulo,
        "description": "\n".join(desc),
        "start": {"dateTime": appt["starts_at"].isoformat(), "timeZone": TZ},
        "end": {"dateTime": (appt.get("ends_at") or (appt["starts_at"] + timedelta(minutes=30))).isoformat(), "timeZone": TZ},
        "extendedProperties": {"private": {"crm_appointment_id": str(appt["id"])}},
    }
    return body


def push_appointment(db: Session, company_id: int, appointment_id: int) -> dict:
    """Crea o actualiza el evento en Google. Si la cita está cancelada, lo borra."""
    conn = _connection_for(db, company_id)
    if not conn:
        return {"ok": False, "reason": "sin calendario conectado"}
    tok = _token(db, conn)
    if not tok:
        return {"ok": False, "reason": "sin acceso a Google (reconectar)"}

    appt = db.execute(
        text("""SELECT a.id, a.starts_at, a.ends_at, a.notes, a.status, a.title,
                       a.external_event_id, c.name AS contact_name, c.number AS contact_number
                FROM appointments a LEFT JOIN contacts c ON c.id = a.contact_id
                WHERE a.id = :i AND a.company_id = :c"""),
        {"i": appointment_id, "c": company_id},
    ).mappings().first()
    if not appt:
        return {"ok": False, "reason": "cita no encontrada"}
    appt = dict(appt)
    cal = conn["calendar_id"] or "primary"
    H = {"Authorization": "Bearer %s" % tok}

    try:
        if str(appt["status"]).lower() == "cancelled":
            if appt["external_event_id"]:
                httpx.delete("%s/calendars/%s/events/%s" % (API, cal, appt["external_event_id"]),
                             headers=H, timeout=25)
                db.execute(text("UPDATE appointments SET external_event_id = NULL, external_synced_at = NOW() "
                                "WHERE id = :i"), {"i": appointment_id})
                db.commit()
            return {"ok": True, "accion": "borrado"}

        body = _event_body(appt)
        if appt["external_event_id"]:
            r = httpx.patch("%s/calendars/%s/events/%s" % (API, cal, appt["external_event_id"]),
                            headers=H, json=body, timeout=25)
            if r.status_code == 404:  # lo borraron en Google: se recrea
                r = httpx.post("%s/calendars/%s/events" % (API, cal), headers=H, json=body, timeout=25)
        else:
            r = httpx.post("%s/calendars/%s/events" % (API, cal), headers=H, json=body, timeout=25)

        if r.status_code not in (200, 201):
            return {"ok": False, "reason": r.text[:200]}
        ev = r.json()
        db.execute(text("UPDATE appointments SET external_event_id = :e, external_calendar_id = :c, "
                        "external_synced_at = NOW() WHERE id = :i"),
                   {"e": ev.get("id"), "c": cal, "i": appointment_id})
        db.commit()
        return {"ok": True, "event_id": ev.get("id")}
    except Exception as e:
        db.rollback()
        return {"ok": False, "reason": str(e)[:150]}


# ── Google → CRM ─────────────────────────────────────────────────────

_PHONE_RE = re.compile(r"\+?\d[\d\s\-()]{7,}")


def _match_contact(db: Session, company_id: int, ev: dict) -> int | None:
    """Busca el cliente del CRM detrás del evento: por teléfono en el texto o
    por mail de un invitado. Si no hay match la cita entra igual, sin cliente."""
    blob = " ".join([str(ev.get("summary") or ""), str(ev.get("description") or ""),
                     str(ev.get("location") or "")])
    for m in _PHONE_RE.findall(blob):
        d = "".join(ch for ch in m if ch.isdigit())
        if len(d) < 8:
            continue
        row = db.execute(
            text('SELECT id FROM contacts WHERE "companyId" = :c AND '
                 "regexp_replace(number, '[^0-9]', '', 'g') LIKE :p LIMIT 1"),
            {"c": company_id, "p": "%" + d[-8:]},
        ).scalar()
        if row:
            return int(row)
    for att in (ev.get("attendees") or []):
        mail = str(att.get("email") or "").strip().lower()
        if not mail:
            continue
        row = db.execute(text('SELECT id FROM contacts WHERE "companyId" = :c AND lower(email) = :m LIMIT 1'),
                         {"c": company_id, "m": mail}).scalar()
        if row:
            return int(row)
    return None


def _parse_dt(node: dict):
    if not node:
        return None
    raw = node.get("dateTime") or node.get("date")
    if not raw:
        return None
    try:
        if len(raw) == 10:  # evento de día completo
            return datetime.fromisoformat(raw + "T00:00:00+00:00")
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except Exception:
        return None


def pull_changes(db: Session, conn: dict) -> dict:
    """Baja los cambios del calendario a la agenda del CRM."""
    tok = _token(db, conn)
    if not tok:
        return {"ok": False, "reason": "sin acceso"}
    cal = conn["calendar_id"] or "primary"
    H = {"Authorization": "Bearer %s" % tok}
    params = {"singleEvents": "true", "showDeleted": "true", "maxResults": 250}
    if conn.get("sync_token"):
        params["syncToken"] = conn["sync_token"]
    else:
        # primera vez: solo de hoy en adelante, no toda la historia del calendario
        params["timeMin"] = datetime.now(timezone.utc).isoformat()

    creadas = actualizadas = borradas = 0
    try:
        while True:
            r = httpx.get("%s/calendars/%s/events" % (API, cal), headers=H, params=params, timeout=30)
            if r.status_code == 410:  # syncToken vencido: se rearma desde cero
                db.execute(text("UPDATE calendar_connections SET sync_token = '' WHERE id = :i"), {"i": conn["id"]})
                db.commit()
                return {"ok": True, "reason": "sync reiniciado"}
            if r.status_code != 200:
                return {"ok": False, "reason": r.text[:200]}
            data = r.json()

            for ev in (data.get("items") or []):
                appt_id = ((ev.get("extendedProperties") or {}).get("private") or {}).get("crm_appointment_id")
                ev_id = ev.get("id")
                cancelado = str(ev.get("status") or "") == "cancelled"

                existente = db.execute(
                    text("SELECT id FROM appointments WHERE company_id = :c AND "
                         "(external_event_id = :e OR id = :a) LIMIT 1"),
                    {"c": conn["company_id"], "e": ev_id, "a": int(appt_id) if (appt_id or "").isdigit() else 0},
                ).scalar()

                if cancelado:
                    if existente:
                        db.execute(text("UPDATE appointments SET status = 'cancelled', external_synced_at = NOW(), "
                                        "updated_at = NOW() WHERE id = :i"), {"i": existente})
                        borradas += 1
                    continue

                starts = _parse_dt(ev.get("start"))
                if not starts:
                    continue
                ends = _parse_dt(ev.get("end")) or (starts + timedelta(minutes=30))
                titulo = str(ev.get("summary") or "Evento de Google")[:255]

                if existente:
                    db.execute(text("""UPDATE appointments SET starts_at = :s, ends_at = :e, title = :t,
                                       external_event_id = :ev, external_calendar_id = :cal,
                                       external_synced_at = NOW(), updated_at = NOW() WHERE id = :i"""),
                               {"s": starts, "e": ends, "t": titulo, "ev": ev_id, "cal": cal, "i": existente})
                    actualizadas += 1
                else:
                    db.execute(text("""INSERT INTO appointments
                        (company_id, contact_id, starts_at, ends_at, service_type, status, notes, title,
                         external_event_id, external_calendar_id, external_synced_at, created_at, updated_at)
                        VALUES (:c, :ct, :s, :e, 'google', 'scheduled', :n, :t, :ev, :cal, NOW(), NOW(), NOW())"""),
                               {"c": conn["company_id"], "ct": _match_contact(db, conn["company_id"], ev),
                                "s": starts, "e": ends, "n": str(ev.get("description") or "")[:2000],
                                "t": titulo, "ev": ev_id, "cal": cal})
                    creadas += 1

            db.commit()
            if data.get("nextPageToken"):
                params["pageToken"] = data["nextPageToken"]
                continue
            db.execute(text("UPDATE calendar_connections SET sync_token = :s, last_sync_at = NOW(), "
                            "last_error = '', updated_at = NOW() WHERE id = :i"),
                       {"s": data.get("nextSyncToken") or "", "i": conn["id"]})
            db.commit()
            break
    except Exception as e:
        db.rollback()
        return {"ok": False, "reason": str(e)[:150]}
    return {"ok": True, "creadas": creadas, "actualizadas": actualizadas, "canceladas": borradas}


async def calendar_sync_loop() -> None:
    """Cada 2 minutos baja los cambios de todos los calendarios conectados."""
    import asyncio
    from app.core.db import SessionLocal

    while True:
        try:
            db = SessionLocal()
            try:
                # lock para que no corran dos réplicas del backend a la vez
                if db.execute(text("SELECT pg_try_advisory_lock(815003)")).scalar():
                    try:
                        conns = db.execute(text("SELECT * FROM calendar_connections WHERE provider = 'google'")).mappings().all()
                        for c in conns:
                            res = pull_changes(db, dict(c))
                            if not res.get("ok"):
                                log.warning("calendar pull company=%s: %s", c["company_id"], res.get("reason"))
                    finally:
                        db.execute(text("SELECT pg_advisory_unlock(815003)"))
                        db.commit()
            finally:
                db.close()
        except Exception as e:
            log.warning("calendar_sync_loop: %s", str(e)[:150])
        await asyncio.sleep(120)
