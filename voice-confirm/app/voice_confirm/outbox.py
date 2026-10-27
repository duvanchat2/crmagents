"""Bandeja de salida en disco: cada llamada es una carpeta en DATA_DIR/calls/<call_id>/.

  request.json    la venta que mandó n8n (lo escribe el dispatcher)
  result.json     el resultado de la llamada (lo escribe el agente al colgar)
  audio.ogg       la grabación completa, cliente y agente (la copia el agente)
  recording.json  dónde quedó la grabación en Bunny (lo escribe el dispatcher)
  delivery.json   intentos de entrega a n8n
  delivered.json  marca de entregado: con esto la llamada queda cerrada

Usar archivos (y no memoria) hace que un reinicio del contenedor no pierda resultados.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import shutil
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx

from .config import DeliverySettings

RETRY_DELAYS_S = (30, 120, 600, 1800, 3600)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def calls_root(data_dir: Path) -> Path:
    return data_dir / "calls"


def call_dir(data_dir: Path, call_id: str) -> Path:
    if "/" in call_id or ".." in call_id or not call_id:
        raise ValueError("call_id inválido")
    return calls_root(data_dir) / call_id


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def read_json(path: Path) -> Any | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def sign(body: bytes, secret: str) -> str:
    """Firma HMAC-SHA256 que n8n puede verificar (cabecera X-Genix-Signature)."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def build_payload(
    call_id: str,
    request: dict[str, Any],
    result: dict[str, Any],
    recording: dict[str, Any] | None,
) -> dict[str, Any]:
    sale = request.get("sale", {})
    return {
        "evento": "confirmacion_llamada",
        "call_id": call_id,
        "venta_id": sale.get("venta_id"),
        "telefono": sale.get("telefono"),
        "estado": result.get("estado"),
        "cedula_coincide": result.get("cedula_coincide"),
        "confirma_condiciones": result.get("confirma_condiciones"),
        "dijo_acepto": result.get("dijo_acepto"),
        "frase_aceptacion": result.get("frase_aceptacion"),
        "motivo_fin": result.get("motivo_fin"),
        "solicitada": request.get("created_at"),
        "contestada": result.get("contestada"),
        "finalizada": result.get("finalizada"),
        "grabacion": recording,
        "transcripcion": result.get("transcripcion", []),
    }


def recording_remote_path(settings: DeliverySettings, call_id: str, venta_id: str, when: datetime) -> str:
    safe_venta = "".join(c if c.isalnum() or c in "-_" else "-" for c in venta_id)[:60]
    return f"{settings.bunny_path_prefix}/{when:%Y}/{when:%m}/{safe_venta}-{call_id}.ogg"


async def upload_to_bunny(
    client: httpx.AsyncClient, settings: DeliverySettings, local: Path, remote_path: str
) -> dict[str, Any]:
    url = f"https://{settings.bunny_storage_host}/{settings.bunny_storage_zone}/{remote_path}"
    with local.open("rb") as fh:
        resp = await client.put(
            url,
            content=fh.read(),
            headers={"AccessKey": settings.bunny_storage_key, "Content-Type": "audio/ogg"},
        )
    resp.raise_for_status()
    info: dict[str, Any] = {"almacen": "bunny", "ruta": remote_path}
    if settings.bunny_pull_zone_url:
        info["url"] = f"{settings.bunny_pull_zone_url}/{remote_path}"
    return info


async def deliver(directory: Path, settings: DeliverySettings, client: httpx.AsyncClient) -> bool:
    """Sube la grabación (si hay) y avisa a n8n. Devuelve True si la llamada quedó entregada."""
    if (directory / "delivered.json").exists():
        return True
    request = read_json(directory / "request.json")
    result = read_json(directory / "result.json")
    if request is None or result is None:
        return False

    call_id = directory.name
    recording = read_json(directory / "recording.json")
    audio = directory / "audio.ogg"
    if recording is None and audio.exists() and audio.stat().st_size > 0:
        if settings.bunny_enabled:
            venta_id = str(request.get("sale", {}).get("venta_id", "venta"))
            remote = recording_remote_path(settings, call_id, venta_id, utcnow())
            recording = await upload_to_bunny(client, settings, audio, remote)
        else:
            recording = {"almacen": "vps", "ruta": str(audio)}
        write_json_atomic(directory / "recording.json", recording)

    # JSON compacto: es lo mismo que produce JSON.stringify en n8n, así la firma se puede verificar ahí.
    payload = build_payload(call_id, request, result, recording)
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    resp = await client.post(
        settings.n8n_webhook_url,
        content=body,
        headers={
            "Content-Type": "application/json",
            "X-Genix-Signature": sign(body, settings.n8n_webhook_secret),
            "X-Genix-Call-Id": call_id,
        },
    )
    resp.raise_for_status()
    write_json_atomic(directory / "delivered.json", {"entregado": utcnow().isoformat(), "http": resp.status_code})
    return True


def due_for_retry(directory: Path, now: datetime) -> bool:
    state = read_json(directory / "delivery.json") or {}
    next_try = state.get("next_try")
    return next_try is None or datetime.fromisoformat(next_try) <= now


def record_failure(directory: Path, error: str, now: datetime) -> None:
    state = read_json(directory / "delivery.json") or {}
    attempts = int(state.get("attempts", 0)) + 1
    delay = RETRY_DELAYS_S[min(attempts - 1, len(RETRY_DELAYS_S) - 1)]
    write_json_atomic(
        directory / "delivery.json",
        {"attempts": attempts, "last_error": error[:500], "next_try": (now + timedelta(seconds=delay)).isoformat()},
    )


def mark_stale_calls(data_dir: Path, max_call_duration_s: int, now: datetime) -> list[str]:
    """Llamadas sin resultado mucho después de lo posible: el agente se cayó. Se cierran como 'fallida'."""
    closed: list[str] = []
    root = calls_root(data_dir)
    if not root.exists():
        return closed
    limit = timedelta(seconds=max_call_duration_s + 600)
    for directory in root.iterdir():
        if not directory.is_dir() or (directory / "result.json").exists():
            continue
        request = read_json(directory / "request.json")
        if not request:
            continue
        created = datetime.fromisoformat(request["created_at"])
        if now - created > limit:
            write_json_atomic(
                directory / "result.json",
                {
                    "estado": "fallida",
                    "motivo_fin": "sin_resultado_del_agente",
                    "finalizada": now.isoformat(),
                    "transcripcion": [],
                },
            )
            closed.append(directory.name)
    return closed


def purge_old(data_dir: Path, retention_days: int, now: datetime) -> list[str]:
    """Borra del VPS las llamadas ya entregadas hace más de LOCAL_RETENTION_DAYS días."""
    removed: list[str] = []
    root = calls_root(data_dir)
    if not root.exists() or retention_days <= 0:
        return removed
    for directory in root.iterdir():
        delivered = read_json(directory / "delivered.json") if directory.is_dir() else None
        if delivered and now - datetime.fromisoformat(delivered["entregado"]) > timedelta(days=retention_days):
            shutil.rmtree(directory, ignore_errors=True)
            removed.append(directory.name)
    return removed


def pending_dirs(data_dir: Path) -> list[Path]:
    root = calls_root(data_dir)
    if not root.exists():
        return []
    return sorted(
        d
        for d in root.iterdir()
        if d.is_dir() and (d / "result.json").exists() and not (d / "delivered.json").exists()
    )
