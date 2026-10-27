import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
import pytest

from voice_confirm.config import DeliverySettings
from voice_confirm.outbox import (
    build_payload,
    call_dir,
    deliver,
    due_for_retry,
    mark_stale_calls,
    pending_dirs,
    purge_old,
    read_json,
    record_failure,
    sign,
    write_json_atomic,
)

NOW = datetime(2026, 10, 27, 15, 0, tzinfo=timezone.utc)


def settings(**overrides: object) -> DeliverySettings:
    base: dict[str, object] = {
        "n8n_webhook_url": "https://n8n.example.com/webhook/confirmacion",
        "n8n_webhook_secret": "secreto",
        "bunny_storage_zone": "",
        "bunny_storage_key": "",
        "bunny_storage_host": "storage.bunnycdn.com",
        "bunny_path_prefix": "grabaciones",
        "bunny_pull_zone_url": "",
        "local_retention_days": 30,
    }
    base.update(overrides)
    return DeliverySettings(**base)  # type: ignore[arg-type]


def make_call(tmp_path: Path, call_id: str = "venta-GX-1-abc123", *, with_result: bool = True, audio: bool = True) -> Path:
    directory = call_dir(tmp_path, call_id)
    write_json_atomic(
        directory / "request.json",
        {"created_at": NOW.isoformat(), "sale": {"venta_id": "GX-1", "telefono": "+573001234567"}},
    )
    if with_result:
        write_json_atomic(
            directory / "result.json",
            {"estado": "confirmada", "cedula_coincide": True, "transcripcion": [{"rol": "cliente", "texto": "sí"}]},
        )
    if audio:
        (directory / "audio.ogg").write_bytes(b"OggS-fake-audio")
    return directory


def test_call_dir_rejects_traversal(tmp_path: Path) -> None:
    for bad in ("", "../x", "a/b"):
        with pytest.raises(ValueError):
            call_dir(tmp_path, bad)


def test_sign_matches_hmac() -> None:
    body = b'{"a":1}'
    expected = hmac.new(b"secreto", body, hashlib.sha256).hexdigest()
    assert sign(body, "secreto") == f"sha256={expected}"


def test_build_payload_fields() -> None:
    payload = build_payload(
        "c1",
        {"created_at": "t0", "sale": {"venta_id": "GX-1", "telefono": "+57300"}},
        {"estado": "revision", "dijo_acepto": False, "transcripcion": []},
        None,
    )
    assert payload["evento"] == "confirmacion_llamada"
    assert payload["venta_id"] == "GX-1"
    assert payload["estado"] == "revision"
    assert payload["dijo_acepto"] is False
    assert payload["grabacion"] is None


async def test_deliver_without_bunny_posts_signed_payload(tmp_path: Path) -> None:
    directory = make_call(tmp_path)
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        assert await deliver(directory, settings(), client) is True

    assert len(seen) == 1
    req = seen[0]
    assert str(req.url) == "https://n8n.example.com/webhook/confirmacion"
    assert req.headers["X-Genix-Signature"] == sign(req.content, "secreto")
    body = json.loads(req.content)
    # n8n verifica con JSON.stringify(body): el cuerpo debe ser JSON compacto sin escapar acentos.
    assert json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode() == req.content
    assert body["estado"] == "confirmada"
    assert body["grabacion"]["almacen"] == "vps"
    assert (directory / "delivered.json").exists()


async def test_deliver_uploads_to_bunny_once(tmp_path: Path) -> None:
    directory = make_call(tmp_path)
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, str(request.url)))
        if request.method == "PUT":
            assert request.headers["AccessKey"] == "clave-bunny"
            return httpx.Response(201)
        return httpx.Response(500)  # n8n caído en el primer intento

    s = settings(bunny_storage_zone="genix", bunny_storage_key="clave-bunny", bunny_pull_zone_url="https://cdn.example.com")
    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(httpx.HTTPStatusError):
            await deliver(directory, s, client)
    recording = read_json(directory / "recording.json")
    assert recording["almacen"] == "bunny"
    assert recording["url"].startswith("https://cdn.example.com/grabaciones/")
    assert not (directory / "delivered.json").exists()

    # Segundo intento: no vuelve a subir el audio, solo reintenta n8n.
    calls.clear()
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
        assert await deliver(directory, s, client) is True
    assert (directory / "delivered.json").exists()


async def test_deliver_waits_for_result(tmp_path: Path) -> None:
    directory = make_call(tmp_path, with_result=False)
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(200))) as client:
        assert await deliver(directory, settings(), client) is False


def test_retry_backoff(tmp_path: Path) -> None:
    directory = make_call(tmp_path)
    assert due_for_retry(directory, NOW)
    record_failure(directory, "timeout", NOW)
    assert not due_for_retry(directory, NOW + timedelta(seconds=10))
    assert due_for_retry(directory, NOW + timedelta(seconds=31))
    record_failure(directory, "timeout", NOW)
    assert read_json(directory / "delivery.json")["attempts"] == 2
    assert not due_for_retry(directory, NOW + timedelta(seconds=60))


def test_mark_stale_calls(tmp_path: Path) -> None:
    make_call(tmp_path, "viejo", with_result=False, audio=False)
    make_call(tmp_path, "en-curso", with_result=False, audio=False)
    write_json_atomic(
        call_dir(tmp_path, "en-curso") / "request.json",
        {"created_at": (NOW + timedelta(minutes=14)).isoformat(), "sale": {}},
    )
    closed = mark_stale_calls(tmp_path, max_call_duration_s=300, now=NOW + timedelta(minutes=16))
    assert closed == ["viejo"]
    assert read_json(call_dir(tmp_path, "viejo") / "result.json")["estado"] == "fallida"
    assert [d.name for d in pending_dirs(tmp_path)] == ["viejo"]


def test_purge_old(tmp_path: Path) -> None:
    old = make_call(tmp_path, "viejo")
    write_json_atomic(old / "delivered.json", {"entregado": (NOW - timedelta(days=31)).isoformat()})
    recent = make_call(tmp_path, "reciente")
    write_json_atomic(recent / "delivered.json", {"entregado": (NOW - timedelta(days=1)).isoformat()})
    assert purge_old(tmp_path, 30, NOW) == ["viejo"]
    assert not old.exists()
    assert recent.exists()
