"""
Menú Bot: flujo determinístico de bienvenida por WhatsApp (estilo Kommo Salesbot,
pero dentro del CRM y sin derivar a otros números).

Config por empresa en bot_flows.flow_json:
  {
    "enabled": true,
    "greeting": "¡Hola! Bienvenido a ...",
    "reopen_hours": 24,            // gap sin mensajes del cliente para re-saludar
    "no_match": "ai",              // texto libre: "ai" (responde el agente) | "menu" (repite menú)
    "options": [
      {
        "label": "Hablar con un asesor",      // botón (máx 20 chars, límite de Meta)
        "reply_text": "Te atiende {asesor}...",
        "stage_id": 12,                        // opcional: mover en el pipeline
        "assign_users": [3, 4],                // opcional: round-robin entre usuarios
        "rr_replies": ["msj user 3", "msj 4"], // opcional: mensaje propio por asesor,
                                               // alineado por posición con assign_users
                                               // (entrada vacía → cae a reply_text)
        "notify_number": "5491122334455",      // opcional: avisar por WA a este número
        "rr_notify_numbers": ["...", "..."],   // opcional: número propio por asesor
                                               // (alineado con assign_users; vacío → notify_number)
        "notify_template": "nuevo_cliente",    // opcional: plantilla del aviso ({{1}}=cliente,
                                               // {{2}}=tel); sin plantilla es texto libre y solo
                                               // entrega dentro de la ventana de 24 h de Meta
        "internal_note": "",                   // opcional: nota interna en el hilo
        "after": "human",                      // "human" pausa la IA; "ai" la deja seguir
        "submenu": {                           // opcional: lista de WhatsApp (máx 10 items)
          "text": "Elegí tu local", "button": "Locales",
          "items": [{"label": "Liniers", "description": "Av. J.B. Justo 9753",
                     "reply_text": "...", "stage_id": null, "internal_note": "...", "after": "human"}]
        }
      }
    ]
  }

Sin estado en el servidor: los ids de los botones codifican la ruta
(mb:root, mb:o0, mb:s0:2), así el flujo nunca se "pierde" aunque el proceso
se reinicie o el cliente conteste días después. El texto libre cae al agente
IA (o re-muestra el menú, según no_match) — lo que Kommo dejaba sin manejar.
"""
from __future__ import annotations

import json
import logging

import httpx
from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.menu_bot")

GRAPH_VERSION = "v21.0"
FLOW_CACHE_TTL = 60


_ensured = False


def ensure_tables(db: Session) -> None:
    # Una sola vez por worker: el ALTER TABLE sobre contacts toma un lock
    # exclusivo y no puede correr en cada request
    global _ensured
    if _ensured:
        return
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS bot_flows (
            company_id INTEGER PRIMARY KEY,
            flow_json TEXT NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"""))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS flow_events (
            id BIGSERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            event_key VARCHAR(40) NOT NULL,
            contact_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )"""))
    db.execute(text("CREATE INDEX IF NOT EXISTS idx_flow_events_company ON flow_events (company_id, event_key)"))
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS rr_counters (
            company_id INTEGER NOT NULL,
            counter_key VARCHAR(40) NOT NULL,
            idx INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (company_id, counter_key)
        )"""))
    has_col = db.execute(text(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'ai_paused'"
    )).scalar()
    if not has_col:
        db.execute(text('ALTER TABLE contacts ADD COLUMN ai_paused BOOLEAN NOT NULL DEFAULT false'))
    db.commit()
    _ensured = True


def get_flow(company_id: int) -> dict:
    from app.services.cache import get_or_set

    def _load():
        from app.core.db import SessionLocal
        db = SessionLocal()
        try:
            ensure_tables(db)
            raw = db.execute(
                text("SELECT flow_json FROM bot_flows WHERE company_id = :cid"), {"cid": company_id}
            ).scalar()
            return json.loads(raw) if raw else {}
        except Exception:
            return {}
        finally:
            db.close()

    return get_or_set(f"bot_flow:{company_id}", FLOW_CACHE_TTL, _load)


def invalidate_flow(company_id: int) -> None:
    try:
        from app.services.cache import invalidate
        invalidate(f"bot_flow:{company_id}")
    except Exception:
        pass


def _event(db: Session, company_id: int, key: str, contact_id: int | None) -> None:
    try:
        db.execute(
            text("INSERT INTO flow_events (company_id, event_key, contact_id) VALUES (:cid, :k, :ct)"),
            {"cid": company_id, "k": key[:40], "ct": contact_id},
        )
        db.commit()
    except Exception:
        db.rollback()


# ── Envío de mensajes interactivos de WhatsApp ────────────────────────

async def _wa_send(wa: dict, payload: dict) -> bool:
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"https://graph.facebook.com/{GRAPH_VERSION}/{wa['phoneId']}/messages",
                json=payload,
                headers={"Authorization": f"Bearer {wa['token']}"},
                timeout=30,
            )
        if resp.status_code == 200:
            return True
        log.warning("menu_bot send failed %s: %s", resp.status_code, resp.text[:200])
        return False
    except Exception as e:
        log.warning("menu_bot send exception: %s", str(e)[:150])
        return False


async def send_buttons(wa: dict, to: str, body: str, buttons: list[tuple[str, str]]) -> bool:
    """buttons: [(id, title)] — Meta permite máx 3 botones, títulos ≤20 chars."""
    return await _wa_send(wa, {
        "messaging_product": "whatsapp", "to": to, "type": "interactive",
        "interactive": {
            "type": "button",
            "body": {"text": body[:1024]},
            "action": {"buttons": [
                {"type": "reply", "reply": {"id": bid, "title": title[:20]}}
                for bid, title in buttons[:3]
            ]},
        },
    })


async def send_list(wa: dict, to: str, body: str, button_label: str, rows: list[tuple[str, str, str]]) -> bool:
    """rows: [(id, title, description)] — máx 10 filas, títulos ≤24, desc ≤72."""
    return await _wa_send(wa, {
        "messaging_product": "whatsapp", "to": to, "type": "interactive",
        "interactive": {
            "type": "list",
            "body": {"text": body[:1024]},
            "action": {
                "button": (button_label or "Ver opciones")[:20],
                "sections": [{"title": "Opciones", "rows": [
                    {"id": rid, "title": title[:24], "description": (desc or "")[:72]}
                    for rid, title, desc in rows[:10]
                ]}],
            },
        },
    })


# ── Motor ─────────────────────────────────────────────────────────────

def _save_bot_message(db: Session, contact_id: int, body: str, company_id: int) -> None:
    try:
        from app.api.v1.endpoints.webhook_whatsapp import save_message
        save_message(db, contact_id, body, True, company_id)
    except Exception:
        db.rollback()


async def _send_menu(db: Session, wa: dict, to: str, flow: dict, company_id: int, contact_id: int) -> None:
    options = flow.get("options") or []
    greeting = flow.get("greeting") or "¡Hola! ¿En qué te podemos ayudar?"
    if len(options) <= 3:
        sent = await send_buttons(wa, to, greeting, [(f"mb:o{i}", o.get("label", f"Opción {i+1}")) for i, o in enumerate(options)])
    else:
        sent = await send_list(wa, to, greeting, flow.get("menu_button", "Ver opciones"),
                               [(f"mb:o{i}", o.get("label", ""), "") for i, o in enumerate(options)])
    if sent:
        _save_bot_message(db, contact_id, greeting, company_id)
        _event(db, company_id, "menu_sent", contact_id)
    else:
        log.warning("menu_bot menu NO enviado company=%s contacto=%s", company_id, contact_id)


def _rr_index(db: Session, company_id: int, key: str, n: int) -> int:
    """Índice round-robin 0..n-1 compartido entre asignación y mensajes."""
    if n <= 1:
        return 0
    try:
        idx = db.execute(text("""
            INSERT INTO rr_counters (company_id, counter_key, idx) VALUES (:cid, :k, 1)
            ON CONFLICT (company_id, counter_key) DO UPDATE SET idx = rr_counters.idx + 1
            RETURNING idx"""), {"cid": company_id, "k": key}).scalar()
        db.commit()
        return (int(idx) - 1) % n
    except Exception:
        db.rollback()
        return 0


async def _run_actions(db: Session, wa: dict, flow: dict, node: dict, event_key: str,
                       company_id: int, contact: dict) -> None:
    contact_id = int(contact["id"])
    to = str(contact.get("number") or "")
    asesor_name = ""

    user_ids = [int(u) for u in (node.get("assign_users") or []) if u]
    rr_replies = [str(r or "") for r in (node.get("rr_replies") or [])]
    # un solo índice RR para usuario y mensaje: la posición k de rr_replies
    # corresponde al asesor k de assign_users (mismo largo desde el editor)
    idx = _rr_index(db, company_id, event_key, max(len(user_ids), len(rr_replies)))
    if user_ids:
        uid = user_ids[idx % len(user_ids)]
        if uid:
            row = db.execute(
                text('SELECT name FROM users WHERE id = :id AND "companyId" = :cid'),
                {"id": uid, "cid": company_id},
            ).mappings().first()
            if row:
                asesor_name = str(row["name"] or "")
                try:
                    db.execute(
                        text('UPDATE contacts SET "assignedUserId" = :u, "updatedAt" = NOW() WHERE id = :id'),
                        {"u": uid, "id": contact_id},
                    )
                    db.commit()
                except Exception:
                    db.rollback()

    stage_id = node.get("stage_id")
    if stage_id:
        try:
            db.execute(text("""
                UPDATE contacts SET stage_id = :s, "updatedAt" = NOW()
                WHERE id = :id AND EXISTS (SELECT 1 FROM lead_stages WHERE id = :s AND company_id = :cid)"""),
                {"s": int(stage_id), "id": contact_id, "cid": company_id})
            db.commit()
        except Exception:
            db.rollback()

    # La nota interna y el aviso al asesor NO se guardan como mensajes del
    # hilo: ensuciaban la conversación con texto que el cliente nunca vio.
    # Quedan trazados en flow_events y en los logs.

    rr_notify = [str(n or "") for n in (node.get("rr_notify_numbers") or [])]
    _cand = rr_notify[idx % len(rr_notify)] if rr_notify else ""
    notify_to = "".join(c for c in (_cand or str(node.get("notify_number") or "")) if c.isdigit())
    if notify_to:
        lead_name = str(contact.get("name") or "").strip() or "Nuevo cliente"
        lead_num = str(contact.get("number") or "")
        tpl = str(node.get("notify_template") or "").strip()

        async def _send_tpl(name: str) -> bool:
            return await _wa_send(wa, {
                "messaging_product": "whatsapp", "to": notify_to, "type": "template",
                "template": {"name": name, "language": {"code": str(node.get("notify_lang") or "es_AR")},
                             "components": [{"type": "body", "parameters": [
                                 {"type": "text", "text": lead_name},
                                 {"type": "text", "text": lead_num or "-"}]}]},
            })

        if tpl:
            sent = await _send_tpl(tpl)
        else:
            body = f"🔔 Nuevo cliente por atender: {lead_name} (+{lead_num})"
            if asesor_name:
                body += f" — asignado a {asesor_name}"
            # texto libre: Meta solo lo entrega si el asesor escribió a la línea en
            # las últimas 24 h; si falla, cae a la plantilla "nuevo_cliente" que se
            # crea automáticamente al conectar WhatsApp
            sent = await _wa_send(wa, {"messaging_product": "whatsapp", "to": notify_to,
                                       "type": "text", "text": {"body": body}})
            if not sent:
                sent = await _send_tpl("nuevo_cliente")
        if sent:
            log.info("menu_bot notify sent company=%s to=%s", company_id, notify_to[:6])
        else:
            log.warning("menu_bot notify FAILED company=%s to=%s", company_id, notify_to[:6])

    reply = ""
    if rr_replies:
        reply = rr_replies[idx % len(rr_replies)].strip()
    if not reply:
        reply = str(node.get("reply_text") or "").strip()
    if reply:
        reply = reply.replace("{asesor}", asesor_name or "nuestro equipo")
        # Solo se guarda si Meta lo aceptó: guardar siempre mostraba en el CRM
        # mensajes que el cliente nunca recibió
        if await send_buttons(wa, to, reply, [("mb:root", "Volver al menú")]):
            _save_bot_message(db, contact_id, reply, company_id)
        else:
            log.warning("menu_bot reply NO enviado company=%s contacto=%s", company_id, contact_id)

    paused = str(node.get("after") or "human") == "human"
    try:
        db.execute(
            text('UPDATE contacts SET ai_paused = :p, "updatedAt" = NOW() WHERE id = :id'),
            {"p": paused, "id": contact_id},
        )
        db.commit()
    except Exception:
        db.rollback()

    _event(db, company_id, event_key, contact_id)


def _is_new_session(db: Session, contact_id: int, reopen_hours: int) -> bool:
    """True si este es el primer mensaje del cliente o si el anterior fue hace
    más de reopen_hours (el mensaje actual ya está guardado: mira el anterior)."""
    try:
        rows = db.execute(text("""
            SELECT "createdAt" FROM messages
            WHERE "contactId" = :cid AND "fromMe" = false
            ORDER BY "createdAt" DESC LIMIT 2"""), {"cid": contact_id}).scalars().all()
        if len(rows) < 2:
            return True
        gap = db.execute(
            text("SELECT EXTRACT(EPOCH FROM (NOW() - :prev ::timestamptz)) / 3600"), {"prev": rows[1]}
        ).scalar()
        return float(gap) >= max(1, reopen_hours)
    except Exception:
        return False


async def handle_inbound(db: Session, company_id: int, contact: dict, msg_text: str,
                         interactive_id: str, wa: dict, channel_id: int | None = None) -> dict:
    """Devuelve {"handled": bool}. handled=True → el webhook NO llama al agente IA."""
    flow = get_flow(company_id)
    options = flow.get("options") or []
    if not flow.get("enabled") or not options or not wa:
        return {"handled": False}

    # El bot puede estar limitado a ciertos canales (vacío = todos)
    allowed = [int(c) for c in (flow.get("channel_ids") or []) if str(c).strip()]
    if allowed and channel_id and int(channel_id) not in allowed:
        return {"handled": False}

    to = str(contact.get("number") or "")
    contact_id = int(contact["id"])

    # Los números de asesores (destinos de avisos) no son clientes: si contestan
    # el aviso en la línea, ni el bot ni la IA deben tratarlos como lead
    asesor_numbers: set[str] = set()
    for o in options:
        for n in [o.get("notify_number")] + list(o.get("rr_notify_numbers") or []):
            if n:
                asesor_numbers.add("".join(c for c in str(n) if c.isdigit()))
        for it in (o.get("submenu") or {}).get("items") or []:
            if it.get("notify_number"):
                asesor_numbers.add("".join(c for c in str(it["notify_number"]) if c.isdigit()))
    if to and "".join(c for c in to if c.isdigit()) in asesor_numbers:
        return {"handled": True}  # silencio: es un asesor, lo atiende el equipo

    if interactive_id.startswith("mb:"):
        ref = interactive_id[3:]
        if ref == "root":
            await _send_menu(db, wa, to, flow, company_id, contact_id)
            return {"handled": True}
        if ref.startswith("o"):
            try:
                opt = options[int(ref[1:])]
            except Exception:
                return {"handled": False}
            sub = opt.get("submenu")
            if sub and (sub.get("items") or []):
                sent = await send_list(wa, to, str(sub.get("text") or "Elegí una opción"), str(sub.get("button") or "Opciones"),
                                       [(f"mb:s{ref[1:]}:{j}", it.get("label", ""), it.get("description", ""))
                                        for j, it in enumerate(sub["items"])])
                if sent:
                    _save_bot_message(db, contact_id, str(sub.get("text") or ""), company_id)
                    _event(db, company_id, ref, contact_id)
                else:
                    log.warning("menu_bot submenu NO enviado company=%s contacto=%s", company_id, contact_id)
            else:
                await _run_actions(db, wa, flow, opt, ref, company_id, contact)
            return {"handled": True}
        if ref.startswith("s"):
            try:
                oi, si = ref[1:].split(":")
                item = (options[int(oi)].get("submenu") or {}).get("items")[int(si)]
            except Exception:
                return {"handled": False}
            await _run_actions(db, wa, flow, item, ref, company_id, contact)
            return {"handled": True}
        return {"handled": False}

    # Texto libre
    if _is_new_session(db, contact_id, int(flow.get("reopen_hours", 24))):
        await _send_menu(db, wa, to, flow, company_id, contact_id)
        return {"handled": True}
    if str(flow.get("no_match", "ai")) == "menu":
        await _send_menu(db, wa, to, flow, company_id, contact_id)
        return {"handled": True}
    return {"handled": False}  # el agente IA responde el texto libre
