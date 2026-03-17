from unittest.mock import MagicMock

import bcrypt
import pytest
from fastapi.testclient import TestClient
from jose import jwt

from app.core.config import settings
from app.core.db import get_db
from app.main import app

_hashed = bcrypt.hashpw(b"secret123", bcrypt.gensalt(rounds=10)).decode("utf-8")

FAKE_USER = {
    "id": 1,
    "name": "Test User",
    "email": "test@example.com",
    "passwordHash": _hashed,
    "profile": "admin",
    "companyId": 10,
}

FAKE_CONTACT = {
    "id": 100,
    "name": "John Doe",
    "number": "5511999990000",
    "email": "john@example.com",
    "whatsappId": None,
    "source": "web",
    "leadStatus": "unread",
    "assignedUserId": None,
    "companyId": 10,
    "inactivityMinutes": 30,
    "inactivityWebhookId": None,
}

FAKE_MESSAGE = {
    "id": 500,
    "body": "Hello world",
    "fromMe": True,
    "contactId": 100,
}


class FakeRow(dict):
    """Mimics SQLAlchemy RowMapping — extends dict so Pydantic v2 can validate it."""

    def __init__(self, data: dict):
        super().__init__(data)


class FakeMappings:
    def __init__(self, rows):
        self._rows = rows

    def first(self):
        return self._rows[0] if self._rows else None

    def all(self):
        return self._rows


class FakeResult:
    def __init__(self, rows):
        self._rows = rows

    def mappings(self):
        return FakeMappings(self._rows)


def _contact_out(c: dict) -> dict:
    """Return contact without passwordHash-like fields."""
    exclude = {"passwordHash", "lastInteractionAt", "lastInactivityFiredAt"}
    return {k: v for k, v in c.items() if k not in exclude}


def make_fake_db():
    """Create a mock DB session that responds to all service queries."""
    db = MagicMock()
    stored_tokens: list[dict] = []
    contacts: dict[int, dict] = {FAKE_CONTACT["id"]: dict(FAKE_CONTACT)}
    messages: list[dict] = [dict(FAKE_MESSAGE)]
    next_msg_id = 501
    next_contact_id = 101

    def fake_execute(query, params=None):
        nonlocal next_msg_id, next_contact_id
        sql = str(query.text if hasattr(query, "text") else query).strip()

        # ── Auth: users ──────────────────────────────────────────
        if "FROM users WHERE email" in sql:
            if params and params.get("email") == FAKE_USER["email"]:
                return FakeResult([FakeRow(FAKE_USER)])
            return FakeResult([])

        if "FROM users WHERE id" in sql:
            if params and params.get("id") == FAKE_USER["id"]:
                user_no_pw = {k: v for k, v in FAKE_USER.items() if k != "passwordHash"}
                return FakeResult([FakeRow(user_no_pw)])
            return FakeResult([])

        # ── Auth: refresh_tokens ─────────────────────────────────
        if "INSERT INTO refresh_tokens" in sql:
            stored_tokens.append(
                {"id": len(stored_tokens) + 1, "token": params["token"], "revoked": False}
            )
            return FakeResult([])

        if "SELECT id FROM refresh_tokens" in sql and "revoked = false" in sql:
            for t in stored_tokens:
                if t["token"] == params.get("token") and not t["revoked"]:
                    return FakeResult([FakeRow({"id": t["id"]})])
            return FakeResult([])

        if "UPDATE refresh_tokens SET revoked = true WHERE id" in sql:
            for t in stored_tokens:
                if t["id"] == params.get("id"):
                    t["revoked"] = True
            return FakeResult([])

        if "UPDATE refresh_tokens SET revoked = true WHERE" in sql and "userId" in sql:
            for t in stored_tokens:
                t["revoked"] = True
            return FakeResult([])

        # ── Contacts: SELECT list ────────────────────────────────
        if sql.startswith("SELECT") and "FROM contacts WHERE" in sql and "companyId" in sql:
            cid = params.get("company_id")
            # Single contact by id
            if params.get("id"):
                c = contacts.get(params["id"])
                if c and c["companyId"] == cid:
                    return FakeResult([FakeRow(_contact_out(c))])
                return FakeResult([])
            # Contact by contact_id (conversations filter)
            if params.get("contact_id"):
                c = contacts.get(params["contact_id"])
                if c and c["companyId"] == cid:
                    conv = {
                        "id": c["id"],
                        "contactName": c["name"],
                        "contactNumber": c["number"],
                        "leadStatus": c["leadStatus"],
                        "assignedUserId": c["assignedUserId"],
                        "updatedAt": "2026-01-01T00:00:00",
                    }
                    return FakeResult([FakeRow(conv)])
                return FakeResult([])
            # List all for company
            rows = [FakeRow(_contact_out(c)) for c in contacts.values() if c["companyId"] == cid]
            return FakeResult(rows)

        # ── Contacts: SELECT by id (without companyId filter — e.g. messages contact check) ──
        if "SELECT id FROM contacts WHERE" in sql and "companyId" in sql:
            c = contacts.get(params.get("id"))
            if c and c["companyId"] == params.get("company_id"):
                return FakeResult([FakeRow({"id": c["id"]})])
            return FakeResult([])

        # ── Contacts: COUNT ──────────────────────────────────────
        if "SELECT COUNT" in sql and "contacts" in sql:
            cid = params.get("company_id")
            cnt = sum(1 for c in contacts.values() if c["companyId"] == cid)
            return FakeResult([FakeRow({"cnt": cnt})])

        # ── Contacts: INSERT ─────────────────────────────────────
        if "INSERT INTO contacts" in sql:
            new_c = {
                "id": next_contact_id,
                "name": params.get("name", ""),
                "number": params.get("number", ""),
                "email": params.get("email"),
                "whatsappId": params.get("whatsappId"),
                "source": params.get("source"),
                "leadStatus": params.get("leadStatus"),
                "assignedUserId": params.get("assignedUserId"),
                "companyId": params.get("companyId") or params.get("company_id"),
                "inactivityMinutes": 30,
                "inactivityWebhookId": None,
            }
            contacts[next_contact_id] = new_c
            next_contact_id += 1
            return FakeResult([FakeRow(_contact_out(new_c))])

        # ── Contacts: UPDATE ─────────────────────────────────────
        if "UPDATE contacts SET" in sql:
            cid = params.get("id") or params.get("contact_id")
            if cid and cid in contacts:
                c = contacts[cid]
                # mark-read sets leadStatus = 'read' as a literal in SQL
                if "'read'" in sql:
                    c["leadStatus"] = "read"
                for key in ["name", "number", "email", "source", "leadStatus", "assignedUserId",
                            "lead_status", "assigned_user_id", "inactivityMinutes", "inactivityWebhookId"]:
                    if key in params and params[key] is not None:
                        mapped = {
                            "lead_status": "leadStatus",
                            "assigned_user_id": "assignedUserId",
                        }.get(key, key)
                        c[mapped] = params[key]
            return FakeResult([])

        # ── Contacts: DELETE ─────────────────────────────────────
        if "DELETE FROM contacts" in sql:
            cid = params.get("id")
            if cid and cid in contacts:
                del contacts[cid]
            return FakeResult([])

        # ── ContactTag ───────────────────────────────────────────
        if "ContactTag" in sql:
            return FakeResult([])

        # ── Messages: DELETE (cascade contact cleanup) ───────────
        if "DELETE FROM messages" in sql:
            return FakeResult([])

        # ── Messages: SELECT with JOIN ───────────────────────────
        if "FROM messages m" in sql and "JOIN contacts" in sql:
            contact_id = params.get("contact_id")
            company_id = params.get("company_id")

            # COUNT
            if "COUNT" in sql:
                cnt = sum(
                    1
                    for m in messages
                    if m["contactId"] == contact_id
                    and contacts.get(contact_id, {}).get("companyId") == company_id
                )
                return FakeResult([FakeRow({"cnt": cnt})])

            matched = [
                FakeRow(m)
                for m in messages
                if m["contactId"] == contact_id
                and contacts.get(contact_id, {}).get("companyId") == company_id
            ]
            return FakeResult(matched)

        # ── Messages: INSERT ─────────────────────────────────────
        if "INSERT INTO messages" in sql:
            new_m = {
                "id": next_msg_id,
                "body": params.get("body"),
                "fromMe": True,
                "contactId": params.get("contact_id"),
            }
            messages.append(new_m)
            next_msg_id += 1
            return FakeResult([FakeRow(new_m)])

        # ── Conversations: SELECT leadStatus after update ────────
        if "SELECT" in sql and "leadStatus" in sql and "assignedUserId" in sql and "contacts" in sql:
            cid = params.get("id")
            c = contacts.get(cid) if cid else None
            if c:
                return FakeResult([FakeRow({"leadStatus": c["leadStatus"], "assignedUserId": c["assignedUserId"]})])
            return FakeResult([])

        return FakeResult([])

    db.execute = fake_execute
    db.commit = MagicMock()
    db._stored_tokens = stored_tokens
    return db


def _make_bearer(user: dict = FAKE_USER) -> dict:
    """Create an Authorization header with a valid JWT."""
    token = jwt.encode(
        {"id": user["id"], "email": user["email"], "profile": user["profile"], "companyId": user["companyId"]},
        settings.jwt_secret,
        algorithm="HS256",
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture()
def client():
    db = make_fake_db()
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app)
    app.dependency_overrides.clear()


@pytest.fixture()
def auth_headers() -> dict:
    return _make_bearer()
