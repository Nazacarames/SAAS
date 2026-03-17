"""Contract tests for /api/conversations — legacy and paginated modes."""


def test_conversations_legacy_array(client, auth_headers):
    """Without page/limit → returns plain array."""
    resp = client.get("/api/conversations/", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)


def test_conversations_paginated(client, auth_headers):
    """With page param → returns {data, total, page, limit, totalPages}."""
    resp = client.get("/api/conversations/?page=1&limit=10", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "data" in data
    assert "total" in data
    assert "page" in data
    assert data["page"] == 1
    assert data["limit"] == 10
    assert "totalPages" in data
    assert isinstance(data["data"], list)
