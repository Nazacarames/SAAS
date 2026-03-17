"""Contract tests for /api/messages — legacy/paginated, idempotency, retry."""


# ── GET legacy array ─────────────────────────────────────────────


def test_messages_legacy_array(client, auth_headers):
    resp = client.get("/api/messages/100", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


# ── GET paginated ────────────────────────────────────────────────


def test_messages_paginated(client, auth_headers):
    resp = client.get("/api/messages/100?page=1&limit=10", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "data" in data
    assert "total" in data
    assert data["page"] == 1
    assert data["limit"] == 10
    assert "totalPages" in data


# ── POST basic ───────────────────────────────────────────────────


def test_send_message_ok(client, auth_headers):
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100},
        headers=auth_headers,
    )
    assert resp.status_code == 201
    assert resp.json()["body"] == "Hi!"


# ── Idempotency key: invalid chars ──────────────────────────────


def test_idempotency_invalid_chars(client, auth_headers):
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100},
        headers={**auth_headers, "x-idempotency-key": "bad key spaces!"},
    )
    assert resp.status_code == 400
    assert "invalid characters" in resp.json()["detail"]


def test_idempotency_too_long(client, auth_headers):
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100},
        headers={**auth_headers, "x-idempotency-key": "a" * 121},
    )
    assert resp.status_code == 400
    assert "too long" in resp.json()["detail"]


def test_idempotency_mismatch(client, auth_headers):
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100, "idempotencyKey": "key-a"},
        headers={**auth_headers, "x-idempotency-key": "key-b"},
    )
    assert resp.status_code == 400
    assert "mismatch" in resp.json()["detail"]


# ── Retry bounds ─────────────────────────────────────────────────


def test_retry_out_of_range(client, auth_headers):
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100, "idempotencyKey": "my-key"},
        headers={**auth_headers, "x-retry-attempt": "1001"},
    )
    assert resp.status_code == 400
    assert "retryAttempt too high" in resp.json()["detail"]


def test_retry_non_integer(client, auth_headers):
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100},
        headers={**auth_headers, "x-retry-attempt": "abc"},
    )
    assert resp.status_code == 400
    assert "retryAttempt invalid" in resp.json()["detail"]


def test_retry_without_idempotency(client, auth_headers):
    """retryAttempt > 1 without explicit key → 400."""
    resp = client.post(
        "/api/messages/",
        json={"body": "Hi!", "contactId": 100, "retryAttempt": 2},
        headers=auth_headers,
    )
    assert resp.status_code == 400
    assert "idempotencyKey" in resp.json()["detail"]
