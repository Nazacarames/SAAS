"""Contract tests for /api/contacts endpoints."""


def test_list_contacts(client, auth_headers):
    resp = client.get("/api/contacts/", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    assert data[0]["companyId"] == 10


def test_update_contact_ok(client, auth_headers):
    resp = client.put(
        "/api/contacts/100",
        json={"name": "Jane Doe", "leadStatus": "qualified"},
        headers=auth_headers,
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["id"] == 100
    assert data["name"] == "Jane Doe"
    assert data["leadStatus"] == "qualified"


def test_update_contact_not_found(client, auth_headers):
    resp = client.put(
        "/api/contacts/99999",
        json={"name": "Ghost"},
        headers=auth_headers,
    )
    assert resp.status_code == 404


def test_delete_contact_ok(client, auth_headers):
    resp = client.delete("/api/contacts/100", headers=auth_headers)
    assert resp.status_code == 204


def test_delete_contact_not_found(client, auth_headers):
    resp = client.delete("/api/contacts/99999", headers=auth_headers)
    assert resp.status_code == 404


def test_mark_read_ok(client, auth_headers):
    resp = client.post("/api/contacts/100/mark-read", headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    assert data["leadStatus"] == "read"


def test_mark_read_not_found(client, auth_headers):
    resp = client.post("/api/contacts/99999/mark-read", headers=auth_headers)
    assert resp.status_code == 404
