"""Prueba del dispatcher con LiveKit y n8n simulados (sin red)."""

from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi.testclient import TestClient

from voice_confirm import dispatcher
from voice_confirm.domain import BOGOTA
from voice_confirm.outbox import read_json, write_json_atomic

TOKEN = "token-de-prueba"
SALE = {
    "venta_id": "GX-000123",
    "telefono": "3001234567",
    "nombre": "Carlos Pérez",
    "cedula": "1234567890",
    "programa": "Inteligencia Artificial para Empresas",
    "valor_total": 480000,
    "numero_cuotas": 6,
    "valor_cuota": 80000,
    "fecha_primera_cuota": "2026-11-05",
}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    env = {
        "LIVEKIT_API_KEY": "k",
        "LIVEKIT_API_SECRET": "s",
        "INTERNAL_TOKEN": "interno",
        "DISPATCHER_TOKEN": TOKEN,
        "N8N_RESULT_WEBHOOK_URL": "https://n8n.example.com/webhook/x",
        "N8N_WEBHOOK_SECRET": "secreto",
        "DATA_DIR": str(tmp_path),
        "COLOMBIA_HOLIDAYS": "",
        "ZADARMA_SIP_USER": "123456-100",
        "ZADARMA_SIP_PASSWORD": "clave",
        "ZADARMA_CALLER_NUMBER": "+576012345678",
        "LIVEKIT_PUBLIC_URL": "",
    }
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    fake_lk = SimpleNamespace(
        agent_dispatch=SimpleNamespace(create_dispatch=AsyncMock()),
        sip=SimpleNamespace(
            list_outbound_trunk=AsyncMock(return_value=SimpleNamespace(items=[SimpleNamespace(name="zadarma-genix")]))
        ),
        aclose=AsyncMock(),
    )
    monkeypatch.setattr(dispatcher.api, "LiveKitAPI", lambda *a, **k: fake_lk)
    monkeypatch.setattr(dispatcher, "SWEEP_EVERY_S", 3600)
    # martes 10:00 en Bogotá: dentro del horario permitido
    monkeypatch.setattr(dispatcher, "utcnow", lambda: datetime(2026, 10, 27, 10, 0, tzinfo=BOGOTA))
    with TestClient(dispatcher.app) as c:
        c.fake_lk = fake_lk  # type: ignore[attr-defined]
        c.data_dir = tmp_path  # type: ignore[attr-defined]
        yield c


def auth() -> dict[str, str]:
    return {"Authorization": f"Bearer {TOKEN}"}


def test_requires_token(client: TestClient) -> None:
    assert client.post("/v1/calls", json=SALE).status_code == 401
    assert client.post("/v1/calls", json=SALE, headers={"Authorization": "Bearer otro"}).status_code == 401


def test_create_call_dispatches_agent(client: TestClient) -> None:
    resp = client.post("/v1/calls", json=SALE, headers=auth())
    assert resp.status_code == 202, resp.text
    call_id = resp.json()["call_id"]
    assert call_id.startswith("venta-GX-000123-")

    req = client.fake_lk.agent_dispatch.create_dispatch.call_args.args[0]  # type: ignore[attr-defined]
    assert req.agent_name == "genix-confirmacion"
    assert req.room == call_id
    assert '"telefono": "+573001234567"' in req.metadata

    stored = read_json(client.data_dir / "calls" / call_id / "request.json")  # type: ignore[attr-defined]
    assert stored["sale"]["cedula"] == "1234567890"

    status = client.get(f"/v1/calls/{call_id}", headers=auth()).json()
    assert status["estado"] == "en_curso"

    # Una segunda llamada para la misma venta mientras la primera sigue en curso: rechazada.
    again = client.post("/v1/calls", json=SALE, headers=auth())
    assert again.status_code == 409
    assert again.json()["detail"]["error"] == "llamada_en_curso"


def test_outside_hours_rejected(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(dispatcher, "utcnow", lambda: datetime(2026, 11, 1, 10, 0, tzinfo=BOGOTA))  # domingo
    resp = client.post("/v1/calls", json=SALE, headers=auth())
    assert resp.status_code == 409
    assert resp.json()["detail"]["error"] == "fuera_de_horario"


def test_invalid_payload(client: TestClient) -> None:
    resp = client.post("/v1/calls", json={**SALE, "telefono": "123"}, headers=auth())
    assert resp.status_code == 422


def test_healthz(client: TestClient) -> None:
    assert client.get("/healthz").json() == {"ok": True, "livekit": True, "troncal_sip": True, "zadarma": True}


def without_zadarma(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZADARMA_SIP_USER", "REEMPLAZA_EXTENSION_ZADARMA")
    client.fake_lk.sip.list_outbound_trunk.return_value = SimpleNamespace(items=[])  # type: ignore[attr-defined]


def test_without_zadarma_only_simulations(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    without_zadarma(client, monkeypatch)
    resp = client.post("/v1/calls", json=SALE, headers=auth())
    assert resp.status_code == 503
    assert resp.json()["detail"]["error"] == "sin_zadarma"
    client.fake_lk.agent_dispatch.create_dispatch.assert_not_called()  # type: ignore[attr-defined]
    # Sano para simular aunque no haya troncal.
    assert client.get("/healthz").json() == {"ok": True, "livekit": True, "troncal_sip": False, "zadarma": False}
    sim = {k: v for k, v in SALE.items() if k != "telefono"}
    assert client.post("/v1/simulaciones", json=sim, headers=auth()).status_code == 202


def test_simulation_dispatches_agent_and_returns_browser_token(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Domingo: una llamada real se rechazaría, pero la simulación no llama a nadie.
    monkeypatch.setattr(dispatcher, "utcnow", lambda: datetime(2026, 11, 1, 22, 0, tzinfo=BOGOTA))
    sim = {k: v for k, v in SALE.items() if k != "telefono"}
    assert client.post("/v1/simulaciones", json=sim).status_code == 401

    resp = client.post("/v1/simulaciones", json=sim, headers=auth())
    assert resp.status_code == 202, resp.text
    body = resp.json()
    call_id = body["call_id"]
    assert call_id.startswith("sim-GX-000123-")
    assert body["estado"] == "esperando"
    assert body["livekit_url"] is None  # la página usa wss://<su propio dominio>

    claims = dispatcher.api.TokenVerifier("k", "s").verify(body["token"])
    assert claims.identity == "cliente"
    assert claims.name == "Carlos Pérez"
    assert claims.video.room == call_id
    assert claims.video.room_join is True
    assert claims.video.can_publish_sources == ["microphone"]

    req = client.fake_lk.agent_dispatch.create_dispatch.call_args.args[0]  # type: ignore[attr-defined]
    assert req.room == call_id
    assert '"simulacion": true' in req.metadata
    stored = read_json(client.data_dir / "calls" / call_id / "request.json")  # type: ignore[attr-defined]
    assert stored["simulacion"] is True
    assert stored["sale"]["telefono"] == "+573000000000"

    status = client.get(f"/v1/calls/{call_id}", headers=auth()).json()
    assert status["simulacion"] is True
    assert status["estado"] == "en_curso"
    assert status["resultado"] is None


def test_call_result_and_recording(client: TestClient) -> None:
    sim = {k: v for k, v in SALE.items() if k != "telefono"}
    call_id = client.post("/v1/simulaciones", json=sim, headers=auth()).json()["call_id"]
    directory = client.data_dir / "calls" / call_id  # type: ignore[attr-defined]
    assert client.get(f"/v1/calls/{call_id}/audio", headers=auth()).status_code == 404

    write_json_atomic(
        directory / "result.json",
        {"estado": "confirmada", "cedula_coincide": True, "transcripcion": [{"rol": "cliente", "texto": "acepto"}]},
    )
    (directory / "audio.ogg").write_bytes(b"OggS-fake-audio")

    status = client.get(f"/v1/calls/{call_id}", headers=auth()).json()
    assert status["estado"] == "confirmada"
    assert status["grabacion"] is True
    assert status["resultado"]["transcripcion"][0]["texto"] == "acepto"

    assert client.get(f"/v1/calls/{call_id}/audio").status_code == 401
    audio = client.get(f"/v1/calls/{call_id}/audio", headers=auth())
    assert audio.status_code == 200
    assert audio.headers["content-type"] == "audio/ogg"
    assert audio.content == b"OggS-fake-audio"
    assert client.get("/v1/calls/no-existe/audio", headers=auth()).status_code == 404


def test_simulator_page(client: TestClient) -> None:
    resp = client.get("/prueba")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/html")
    html = resp.text
    assert "/v1/simulaciones" in html
    assert 'livekit-client@2.22.3/dist/livekit-client.umd.js"' in html
    assert 'integrity="sha384-' in html


def test_internal_done_delivers(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    call_id = client.post("/v1/calls", json=SALE, headers=auth()).json()["call_id"]
    directory = client.data_dir / "calls" / call_id  # type: ignore[attr-defined]
    write_json_atomic(directory / "result.json", {"estado": "confirmada", "transcripcion": []})

    sent: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(request)
        return httpx.Response(200)

    monkeypatch.setattr(dispatcher.state, "http", httpx.AsyncClient(transport=httpx.MockTransport(handler)))

    # TestClient se presenta como "testclient", no como 127.0.0.1: el endpoint interno lo rechaza.
    assert client.post(f"/internal/calls/{call_id}/done", headers={"X-Internal-Token": "interno"}).status_code == 403

    local = TestClient(dispatcher.app, client=("127.0.0.1", 50000))
    assert local.post(f"/internal/calls/{call_id}/done", headers={"X-Internal-Token": "mal"}).status_code == 401
    assert local.post(f"/internal/calls/{call_id}/done", headers={"X-Internal-Token": "interno"}).status_code == 202
    assert len(sent) == 1
    assert (directory / "delivered.json").exists()
    assert client.get(f"/v1/calls/{call_id}", headers=auth()).json()["entregado_a_n8n"] is True
