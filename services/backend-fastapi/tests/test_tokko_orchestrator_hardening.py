import pytest

from app.services import conversation_orchestrator as co


def test_type_matching_is_strict_house_vs_warehouse():
    assert co._type_matches_strict("house", "house") is True
    assert co._type_matches_strict("warehouse", "house") is False


def test_normalize_results_accepts_multiple_shapes():
    payload_a = {"results": [{"id": 1, "title": "A"}]}
    payload_b = {"objects": [{"id": 2, "address": "B", "type": "house", "operations": []}]}

    out_a = co._normalize_search_results(payload_a)
    out_b = co._normalize_search_results(payload_b)

    assert len(out_a) == 1
    assert out_a[0]["id"] == 1
    assert len(out_b) == 1
    assert out_b[0]["id"] == 2
    assert out_b[0]["title"] == "B"


def test_force_renderer_uses_normalized_tool_output():
    orch = co.ConversationOrchestrator(company_id=1)
    orch.tool_calls = [
        {
            "tool": "search_properties",
            "result": {
                "ok": True,
                "results": [
                    {"id": 10, "title": "Casa", "location": "Funes", "price": "USD 100,000", "url": "u1"}
                ],
                "meta": {"fallback_used": False},
            },
        }
    ]

    rendered = orch._force_property_results_reply("No encontré opciones exactas")
    assert "Te paso opciones concretas" in rendered
    assert "Casa" in rendered


@pytest.mark.asyncio
async def test_execute_tool_fallback_and_dedupe(monkeypatch):
    class _Resp:
        status_code = 200

        def json(self):
            return {
                "objects": [
                    {
                        "id": 1,
                        "address": "Casa 1",
                        "type": "house",
                        "location": {"full_location": "Rosario"},
                        "operations": [{"prices": [{"price": 90000}]}],
                    },
                    {
                        "id": 1,
                        "address": "Casa 1 dup",
                        "type": "house",
                        "location": {"full_location": "Rosario"},
                        "operations": [{"prices": [{"price": 90000}]}],
                    },
                    {
                        "id": 2,
                        "address": "Warehouse X",
                        "type": "warehouse",
                        "location": {"full_location": "Rosario"},
                        "operations": [{"prices": [{"price": 85000}]}],
                    },
                ]
            }

    class _Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, *args, **kwargs):
            return _Resp()

    monkeypatch.setattr(co.httpx, "AsyncClient", _Client)

    result = await co.execute_tool(
        tool_name="search_properties",
        tool_args={"location": "Funes", "property_type": "house", "price_max": 100000, "rooms": 5},
        company_id=1,
        db=None,
    )

    assert result["ok"] is True
    assert result["meta"]["fallback_used"] is True  # strict location fails, fallback relaxes location
    assert len(result["results"]) == 1  # deduped + strict type excludes warehouse
    assert result["results"][0]["id"] == 1
