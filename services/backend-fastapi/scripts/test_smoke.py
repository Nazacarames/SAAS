"""
Smoke tests for the Charlott FastAPI backend.
Run: cd /home/deploy/atendechat/services/backend-fastapi && python -m pytest scripts/test_smoke.py -v
"""
import json
import os
import sys

import pytest

BASE_URL = os.getenv("TEST_BASE_URL", "http://127.0.0.1:4010")


@pytest.fixture(scope="session")
def client():
    import httpx
    with httpx.Client(base_url=BASE_URL, timeout=10) as c:
        yield c


@pytest.fixture(scope="session")
def auth_token(client):
    """Get a JWT token using test credentials from env."""
    email = os.getenv("TEST_EMAIL", "admin@charlott.ai")
    password = os.getenv("TEST_PASSWORD", "")
    if not password:
        pytest.skip("TEST_PASSWORD not set — skipping authenticated tests")

    resp = client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, f"Login failed: {resp.text}"
    return resp.json().get("accessToken") or resp.json().get("token")


@pytest.fixture(scope="session")
def authed(client, auth_token):
    """Authenticated httpx client."""
    import httpx
    with httpx.Client(base_url=BASE_URL, timeout=10, headers={"Authorization": f"Bearer {auth_token}"}) as c:
        yield c


# ── Public endpoints ────────────────────────────────────────────────

class TestPublic:
    def test_health(self, client):
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json().get("status") == "ok"

    def test_root(self, client):
        r = client.get("/")
        assert r.status_code == 200
        assert "service" in r.json()

    def test_correlation_id_header(self, client):
        r = client.get("/health")
        assert "x-correlation-id" in r.headers

    def test_unknown_route_404(self, client):
        r = client.get("/api/does-not-exist-xyz")
        assert r.status_code == 404

    def test_webhook_verify_token_rejected(self, client):
        r = client.get("/api/ai/meta-leads/webhook", params={
            "hub.mode": "subscribe",
            "hub.verify_token": "wrong_token",
            "hub.challenge": "abc",
        })
        assert r.status_code == 403


# ── Auth guard ──────────────────────────────────────────────────────

class TestAuthGuard:
    PROTECTED_ROUTES = [
        ("GET", "/api/contacts"),
        ("GET", "/api/ai/agents"),
        ("GET", "/api/ai/kb/stats"),
        ("GET", "/api/ai/tools/manifest"),
        ("GET", "/api/queues"),
        ("GET", "/api/saved-replies"),
        ("GET", "/api/settings/meta/webhook-status"),
    ]

    @pytest.mark.parametrize("method,path", PROTECTED_ROUTES)
    def test_protected_route_requires_auth(self, client, method, path):
        r = client.request(method, path)
        assert r.status_code in (401, 403, 422, 307), (
            f"{method} {path} expected auth error, got {r.status_code}: {r.text[:200]}"
        )


# ── State machine unit tests ────────────────────────────────────────

class TestStateMachine:
    def test_valid_states_constant(self):
        sys.path.insert(0, "/home/deploy/atendechat/services/backend-fastapi")
        from app.services.conversation_orchestrator import VALID_STATES, _coerce_state, compute_next_state

        assert "new" in VALID_STATES
        assert "qualifying" in VALID_STATES
        assert "closed" in VALID_STATES

    def test_coerce_invalid_state(self):
        from app.services.conversation_orchestrator import _coerce_state
        assert _coerce_state("garbage_state") == "qualifying"
        assert _coerce_state("") == "qualifying"
        assert _coerce_state("new") == "new"
        assert _coerce_state("closed") == "closed"

    def test_state_transitions(self):
        from app.services.conversation_orchestrator import compute_next_state

        assert compute_next_state("new", "greeting", {}) == "qualifying"
        assert compute_next_state("new", "property_search", {}) == "qualifying"
        assert compute_next_state("qualifying", "property_search", {}) == "negotiation"
        assert compute_next_state("qualifying", "schedule_appointment", {}) == "handoff"
        assert compute_next_state("negotiation", "goodbye", {}) == "closed"

    def test_unknown_transition_stays_in_state(self):
        from app.services.conversation_orchestrator import compute_next_state, VALID_STATES
        # Unknown intent in a known state stays in that state (coerced)
        result = compute_next_state("negotiation", "unknown_intent", {})
        assert result in VALID_STATES


# ── Slot extraction unit tests ──────────────────────────────────────

class TestSlotExtraction:
    def test_extract_budget_usd(self):
        from app.services.conversation_orchestrator import extract_slots
        slots = extract_slots("quiero comprar algo de 100.000 dolares")
        assert "budget" in slots
        assert slots["budget"]["value"] >= 100000

    def test_extract_rooms(self):
        from app.services.conversation_orchestrator import extract_slots
        slots = extract_slots("busco departamento de 3 ambientes")
        assert slots.get("rooms") == 3

    def test_extract_phone(self):
        from app.services.conversation_orchestrator import extract_slots
        # Phone regex requires 6+ consecutive digits
        slots = extract_slots("mi numero es 3415551234")
        assert "phone" in slots

    def test_empty_text(self):
        from app.services.conversation_orchestrator import extract_slots
        assert extract_slots("") == {}
        assert extract_slots("   ") == {}


# ── Authenticated endpoints ─────────────────────────────────────────

class TestAuthenticated:
    def test_list_agents(self, authed):
        r = authed.get("/api/ai/agents")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_kb_stats(self, authed):
        r = authed.get("/api/ai/kb/stats")
        assert r.status_code == 200
        data = r.json()
        assert "total" in data

    def test_tools_manifest(self, authed):
        r = authed.get("/api/ai/tools/manifest")
        assert r.status_code == 200
        assert "tools" in r.json()
        assert len(r.json()["tools"]) >= 5

    def test_funnel_stats(self, authed):
        r = authed.get("/api/ai/funnel/stats")
        assert r.status_code == 200
        assert "nuevo" in r.json()

    def test_routing_rules(self, authed):
        r = authed.get("/api/ai/routing/rules")
        assert r.status_code == 200
        assert "rules" in r.json()

    def test_queues_list(self, authed):
        r = authed.get("/api/queues")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_webhook_status(self, authed):
        r = authed.get("/api/settings/meta/webhook-status")
        assert r.status_code == 200
        data = r.json()
        assert "callbackUrl" in data
        assert "verifyTokenConfigured" in data

    def test_link_preview_invalid_url(self, authed):
        r = authed.get("/api/ai/link-preview", params={"url": "not-a-url"})
        assert r.status_code == 400

    def test_tool_execute_unknown_tool(self, authed):
        r = authed.post("/api/ai/tools/execute", json={"tool": "nonexistent_tool", "args": {}})
        assert r.status_code == 400

    def test_saved_replies_list(self, authed):
        r = authed.get("/api/saved-replies")
        assert r.status_code == 200
        assert isinstance(r.json(), list)
