"""Auth endpoint tests: login, refresh, logout."""


# ── Login ────────────────────────────────────────────────────────


def test_login_ok(client):
    resp = client.post("/api/auth/login", json={"email": "test@example.com", "password": "secret123"})
    assert resp.status_code == 200
    data = resp.json()
    assert data["token"]
    assert data["user"]["email"] == "test@example.com"
    assert data["user"]["companyId"] == 10
    # Cookies set
    assert "token" in resp.cookies
    assert "refreshToken" in resp.cookies


def test_login_invalid_credentials(client):
    resp = client.post("/api/auth/login", json={"email": "test@example.com", "password": "wrong"})
    assert resp.status_code == 401

    resp2 = client.post("/api/auth/login", json={"email": "nobody@example.com", "password": "secret123"})
    assert resp2.status_code == 401


# ── Refresh ──────────────────────────────────────────────────────


def test_refresh_ok(client):
    # First login to get tokens
    login_resp = client.post(
        "/api/auth/login", json={"email": "test@example.com", "password": "secret123"}
    )
    refresh_token = login_resp.cookies.get("refreshToken")
    assert refresh_token

    # Refresh using JSON body
    resp = client.post("/api/auth/refresh", json={"refreshToken": refresh_token})
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["token"]


def test_refresh_invalid(client):
    resp = client.post("/api/auth/refresh", json={"refreshToken": "invalid.jwt.token"})
    assert resp.status_code == 401


# ── Logout ───────────────────────────────────────────────────────


def test_logout_clears_cookies(client):
    # Login first
    login_resp = client.post(
        "/api/auth/login", json={"email": "test@example.com", "password": "secret123"}
    )
    token = login_resp.json()["token"]

    # Logout with bearer
    resp = client.post("/api/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True

    # Cookies should be cleared (max-age=0)
    set_cookie_headers = [v for k, v in resp.headers.items() if k.lower() == "set-cookie"]
    token_cookies = [h for h in set_cookie_headers if "token" in h.lower()]
    assert len(token_cookies) >= 1
    for header in token_cookies:
        assert 'max-age=0' in header.lower() or '="";' in header
