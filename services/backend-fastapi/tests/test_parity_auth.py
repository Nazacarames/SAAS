"""
Parity smoke tests — contractual verification that FastAPI auth endpoints
produce the same response shapes and HTTP codes as the Node.js backend.
"""


class TestLoginParity:
    """POST /api/auth/login must match Node contract."""

    def test_response_shape(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"email": "test@example.com", "password": "secret123"},
        )
        data = resp.json()
        assert resp.status_code == 200

        # Must contain user + token
        assert "user" in data
        assert "token" in data

        # User shape
        user = data["user"]
        for field in ("id", "name", "email", "profile", "companyId"):
            assert field in user, f"Missing field: {field}"

    def test_cookies_set(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"email": "test@example.com", "password": "secret123"},
        )
        assert "token" in resp.cookies
        assert "refreshToken" in resp.cookies

    def test_invalid_returns_401(self, client):
        resp = client.post(
            "/api/auth/login",
            json={"email": "test@example.com", "password": "wrong"},
        )
        assert resp.status_code == 401


class TestRefreshParity:
    """POST /api/auth/refresh must match Node contract."""

    def test_response_shape(self, client):
        login = client.post(
            "/api/auth/login",
            json={"email": "test@example.com", "password": "secret123"},
        )
        rt = login.cookies.get("refreshToken")
        resp = client.post("/api/auth/refresh", json={"refreshToken": rt})
        assert resp.status_code == 200
        data = resp.json()
        assert data["ok"] is True
        assert "token" in data

    def test_invalid_returns_401(self, client):
        resp = client.post("/api/auth/refresh", json={"refreshToken": "bad"})
        assert resp.status_code == 401


class TestLogoutParity:
    """POST /api/auth/logout must match Node contract."""

    def test_response_shape(self, client):
        login = client.post(
            "/api/auth/login",
            json={"email": "test@example.com", "password": "secret123"},
        )
        token = login.json()["token"]
        resp = client.post(
            "/api/auth/logout",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status_code == 200
        assert resp.json() == {"ok": True}


class TestMeParity:
    """GET /api/auth/me must match Node contract."""

    def test_response_shape(self, client):
        login = client.post(
            "/api/auth/login",
            json={"email": "test@example.com", "password": "secret123"},
        )
        token = login.json()["token"]
        resp = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        data = resp.json()
        assert "user" in data
        for field in ("id", "name", "email", "profile", "companyId"):
            assert field in data["user"]

    def test_no_token_returns_401(self, client):
        resp = client.get("/api/auth/me")
        assert resp.status_code == 401
