"""
Memoria de aprendizajes del agente (por empresa).

Cada agente acumula "lecciones" — frases cortas y accionables sobre cómo son
sus clientes y qué funciona para vender — que se inyectan en su system prompt.
Dos fuentes:
  - manual: las carga el humano desde el panel (active=true).
  - auto:   se destilan de conversaciones que cerraron bien (active=false,
            quedan como propuestas para que el humano revise antes de activar).

No es fine-tuning: es texto inyectado en el prompt, así que aplica al toque,
es barato y es totalmente aislado por empresa.
"""
import hashlib
import json
import logging

from sqlalchemy import text
from sqlalchemy.orm import Session

log = logging.getLogger("app.agent_learning")

ACTIVE_LESSON_CAP = 25          # máximo de lecciones inyectadas al prompt
DISTILL_MAX_PER_RUN = 2         # lecciones nuevas por destilación
DISTILL_LOOKBACK_DAYS = 21      # ventana de conversaciones a analizar
LESSONS_CACHE_TTL = 60


def _hash(content: str) -> str:
    norm = " ".join(content.lower().split())
    return hashlib.sha256(norm.encode()).hexdigest()[:40]


def ensure_table(db: Session) -> None:
    db.execute(text("""
        CREATE TABLE IF NOT EXISTS agent_lessons (
            id BIGSERIAL PRIMARY KEY,
            company_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            source VARCHAR(10) NOT NULL DEFAULT 'manual',
            active BOOLEAN NOT NULL DEFAULT true,
            content_hash VARCHAR(64) NOT NULL,
            times_used INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (company_id, content_hash)
        )"""))
    db.commit()


def active_lessons_text(company_id: int) -> str:
    """Bloque de aprendizajes activos para inyectar en el prompt (cacheado)."""
    from app.services.cache import get_or_set

    def _load():
        from app.core.db import SessionLocal
        db = SessionLocal()
        try:
            ensure_table(db)
            rows = db.execute(
                text("""SELECT content FROM agent_lessons
                        WHERE company_id = :cid AND active = true
                        ORDER BY id ASC LIMIT :cap"""),
                {"cid": company_id, "cap": ACTIVE_LESSON_CAP},
            ).mappings().all()
            if not rows:
                return ""
            lines = "\n".join(f"- {r['content']}" for r in rows)
            return ("APRENDIZAJES DEL NEGOCIO (aplicá estos aprendizajes acumulados "
                    "sobre cómo son los clientes y qué funciona para vender):\n" + lines + "\n")
        finally:
            db.close()

    return get_or_set(f"lessons:{company_id}", LESSONS_CACHE_TTL, _load)


def invalidate(company_id: int) -> None:
    try:
        from app.services.cache import invalidate as _inv
        _inv(f"lessons:{company_id}")
    except Exception:
        pass


def add_lesson(db: Session, company_id: int, content: str, source: str = "manual",
               active: bool | None = None) -> dict | None:
    ensure_table(db)
    content = content.strip()
    if not content:
        return None
    if active is None:
        active = source == "manual"  # manual entra activo; auto queda pendiente
    row = db.execute(
        text("""INSERT INTO agent_lessons (company_id, content, source, active, content_hash)
                VALUES (:cid, :content, :source, :active, :h)
                ON CONFLICT (company_id, content_hash) DO NOTHING
                RETURNING id, content, source, active"""),
        {"cid": company_id, "content": content[:600], "source": source, "active": active, "h": _hash(content)},
    ).mappings().first()
    db.commit()
    if row:
        invalidate(company_id)
        return dict(row)
    return None


# ── Auto-destilación ─────────────────────────────────────────────────

def _successful_conversations(db: Session, company_id: int, limit: int = 12) -> list[dict]:
    """Contactos que cerraron bien (hot/customer o con cita) recientemente, con
    un extracto de su conversación."""
    rows = db.execute(
        text("""
            SELECT c.id, c.name, c."leadStatus", c.needs
            FROM contacts c
            WHERE c."companyId" = :cid
              AND (c."leadStatus" IN ('hot', 'customer')
                   OR EXISTS (SELECT 1 FROM appointments a WHERE a.contact_id = c.id))
              AND c."updatedAt" >= NOW() - (:days || ' days')::interval
            ORDER BY c."updatedAt" DESC LIMIT :lim
        """),
        {"cid": company_id, "days": DISTILL_LOOKBACK_DAYS, "lim": limit},
    ).mappings().all()
    convos = []
    for c in rows:
        msgs = db.execute(
            text('SELECT body, "fromMe" FROM messages WHERE "contactId" = :cid ORDER BY id ASC LIMIT 30'),
            {"cid": c["id"]},
        ).mappings().all()
        transcript = "\n".join(
            f"{'Asesor' if m['fromMe'] else 'Cliente'}: {str(m['body'])[:180]}"
            for m in msgs if m["body"] and not str(m["body"]).startswith("[")
        )
        if transcript.strip():
            convos.append({"status": c["leadStatus"], "needs": c["needs"] or "", "transcript": transcript[:2200]})
    return convos


def distill_for_company(db: Session, company_id: int) -> list[dict]:
    """Analiza conversaciones exitosas y propone lecciones nuevas (auto, inactivas).
    Devuelve las lecciones creadas. No auto-activa: quedan para revisión humana."""
    ensure_table(db)
    from app.core.config import settings
    if not settings.openai_api_key:
        return []

    convos = _successful_conversations(db, company_id)
    if len(convos) < 2:
        return []  # muy pocos datos para aprender algo confiable

    existing = db.execute(
        text("SELECT content FROM agent_lessons WHERE company_id = :cid ORDER BY id DESC LIMIT 40"),
        {"cid": company_id},
    ).mappings().all()
    prev = "\n".join(f"- {r['content']}" for r in existing) or "(ninguno todavía)"

    blob = "\n\n---\n".join(
        f"[Resultado: {c['status']}] Búsqueda: {c['needs']}\n{c['transcript']}" for c in convos
    )[:9000]

    try:
        import asyncio  # noqa
        from openai import OpenAI
        client = OpenAI(api_key=settings.openai_api_key, timeout=40.0, max_retries=1)
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{
                "role": "user",
                "content": (
                    "Sos un coach de ventas analizando conversaciones REALES de una inmobiliaria "
                    "que terminaron bien (lead caliente, cliente o visita agendada).\n\n"
                    f"Aprendizajes que el agente YA tiene (no repitas ninguno):\n{prev}\n\n"
                    f"Conversaciones exitosas:\n{blob}\n\n"
                    f"Extraé como máximo {DISTILL_MAX_PER_RUN} APRENDIZAJES nuevos, cortos y accionables "
                    "sobre cómo son estos clientes o qué funcionó para avanzar la venta. Cada uno en "
                    "una sola línea imperativa, concreto y aplicable en futuras conversaciones "
                    "(ej: 'Cuando el cliente duda por el precio, ofrecer opciones de financiación antes "
                    "de bajar expectativas'). Si no hay ningún patrón claro y nuevo, devolvé lista vacía.\n"
                    "Respondé SOLO un JSON: {\"lessons\": [\"...\", \"...\"]}"
                ),
            }],
            max_tokens=300,
            temperature=0.4,
            response_format={"type": "json_object"},
        )
        data = json.loads(resp.choices[0].message.content or "{}")
        lessons = [str(x).strip() for x in (data.get("lessons") or []) if str(x).strip()][:DISTILL_MAX_PER_RUN]
    except Exception as e:
        log.warning("distill failed company=%s: %s", company_id, str(e)[:120])
        return []

    created = []
    for text_lesson in lessons:
        row = add_lesson(db, company_id, text_lesson, source="auto", active=False)
        if row:
            created.append(row)
    if created:
        log.info("distilled %d lessons for company=%s", len(created), company_id)
    return created


# ── Loop diario: el agente aprende solo con el tiempo ────────────────

DISTILL_LOOP_INTERVAL = 24 * 3600
_DISTILL_LOCK_KEY = 815002


def _distill_all() -> None:
    from app.core.db import SessionLocal
    db = SessionLocal()
    try:
        if not db.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": _DISTILL_LOCK_KEY}).scalar():
            return
        companies = db.execute(
            text("SELECT DISTINCT company_id FROM ai_agents WHERE is_active = true")
        ).mappings().all()
        from app.services.billing_service import check_subscription_active
        for row in companies:
            cid = int(row["company_id"])
            ok, _ = check_subscription_active(db, cid)
            if not ok:
                continue
            try:
                distill_for_company(db, cid)
            except Exception as e:
                log.warning("distill loop company=%s: %s", cid, str(e)[:120])
    finally:
        try:
            db.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": _DISTILL_LOCK_KEY})
            db.commit()
        except Exception:
            pass
        db.close()


async def distill_loop() -> None:
    import asyncio
    log.info("agent learning loop started (daily)")
    await asyncio.sleep(600)  # no competir con el arranque
    while True:
        try:
            await asyncio.to_thread(_distill_all)
        except Exception as e:
            log.error("distill loop error: %s", e)
        await asyncio.sleep(DISTILL_LOOP_INTERVAL)
