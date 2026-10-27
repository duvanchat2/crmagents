"""API HTTP que usa n8n para pedir llamadas, y entrega de resultados a n8n.

  POST /v1/calls             n8n pide una llamada (Bearer DISPATCHER_TOKEN)
  GET  /v1/calls/{call_id}   estado y resultado de una llamada (Bearer DISPATCHER_TOKEN)
  GET  /v1/calls/{call_id}/audio   la grabación (Bearer DISPATCHER_TOKEN)
  POST /v1/simulaciones      llamada simulada: el "cliente" habla desde el navegador, sin Zadarma
  GET  /prueba               página del simulador (pide el DISPATCHER_TOKEN)
  GET  /healthz              salud: LiveKit responde y la troncal existe
  POST /internal/calls/{id}/done   el agente avisa que colgó (solo localhost, X-Internal-Token)

Ejecutar:  uvicorn voice_confirm.dispatcher:app --host 127.0.0.1 --port 8088
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Annotated, Any

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from livekit import api
from pydantic import BaseModel, Field, field_validator

from .config import DeliverySettings, Settings, dispatcher_token, zadarma_configured
from .domain import (
    CLIENT_IDENTITY,
    InvalidPhone,
    Sale,
    digits_only,
    is_contact_allowed,
    normalize_co_phone,
    safe_room_fragment,
)
from .outbox import (
    call_dir,
    calls_root,
    deliver,
    due_for_retry,
    mark_stale_calls,
    pending_dirs,
    purge_old,
    read_json,
    record_failure,
    utcnow,
    write_json_atomic,
)

logger = logging.getLogger("genix.dispatcher")
SWEEP_EVERY_S = 60
SIMULATOR_PAGE = Path(__file__).parent / "static" / "prueba.html"
SIMULATOR_TOKEN_TTL = timedelta(minutes=15)


class SaleIn(BaseModel):
    venta_id: str = Field(min_length=1, max_length=80)
    telefono: str
    nombre: str = Field(min_length=2, max_length=120)
    cedula: str
    programa: str = Field(min_length=2, max_length=200)
    contenido: str = Field(default="", max_length=300)
    valor_total: int = Field(gt=0)
    numero_cuotas: int = Field(ge=1, le=120)
    valor_cuota: int = Field(gt=0)
    fecha_primera_cuota: date
    periodicidad: str = Field(default="mensuales", max_length=30)
    asesor: str = Field(default="", max_length=120)

    @field_validator("telefono")
    @classmethod
    def _phone(cls, v: str) -> str:
        try:
            return normalize_co_phone(v)
        except InvalidPhone as exc:
            raise ValueError(str(exc)) from exc

    @field_validator("cedula")
    @classmethod
    def _cedula(cls, v: str) -> str:
        digits = digits_only(v)
        if not 5 <= len(digits) <= 12:
            raise ValueError("La cédula debe tener entre 5 y 12 dígitos")
        return digits

    def to_sale(self) -> Sale:
        return Sale.from_dict(self.model_dump(mode="json"))


class SimulacionIn(SaleIn):
    """Igual que una venta, pero sin teléfono: el "cliente" contesta desde el navegador."""

    telefono: str = "+573000000000"


class State:
    settings: Settings
    delivery: DeliverySettings
    token: str
    http: httpx.AsyncClient
    lkapi: api.LiveKitAPI
    sweeper: asyncio.Task[None]


state = State()


async def sweep_once() -> None:
    now = utcnow()
    for call_id in mark_stale_calls(state.settings.data_dir, state.settings.max_call_duration_s, now):
        logger.warning("llamada sin resultado del agente, cerrada como fallida", extra={"call_id": call_id})
    for directory in pending_dirs(state.settings.data_dir):
        if due_for_retry(directory, now):
            await try_deliver(directory.name)
    purge_old(state.settings.data_dir, state.delivery.local_retention_days, now)


async def sweeper_loop() -> None:
    while True:
        try:
            await sweep_once()
        except Exception:
            logger.exception("error en el barrido de entregas")
        await asyncio.sleep(SWEEP_EVERY_S)


async def try_deliver(call_id: str) -> None:
    directory = call_dir(state.settings.data_dir, call_id)
    try:
        if await deliver(directory, state.delivery, state.http):
            logger.info("resultado entregado a n8n", extra={"call_id": call_id})
    except Exception as exc:  # se reintenta con espera creciente
        record_failure(directory, f"{type(exc).__name__}: {exc}", utcnow())
        logger.warning("no se pudo entregar el resultado, se reintentará", extra={"call_id": call_id})


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    state.settings = Settings.load()
    state.delivery = DeliverySettings.load()
    state.token = dispatcher_token()
    state.http = httpx.AsyncClient(timeout=httpx.Timeout(30.0))
    state.lkapi = api.LiveKitAPI(
        state.settings.livekit_url, state.settings.livekit_api_key, state.settings.livekit_api_secret
    )
    calls_root(state.settings.data_dir).mkdir(parents=True, exist_ok=True)
    state.sweeper = asyncio.create_task(sweeper_loop())
    try:
        yield
    finally:
        state.sweeper.cancel()
        await state.lkapi.aclose()
        await state.http.aclose()


app = FastAPI(title="Genix · Confirmación por voz", lifespan=lifespan)


def require_token(authorization: Annotated[str | None, Header()] = None) -> None:
    expected = f"Bearer {state.token}"
    if not authorization or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(status_code=401, detail="Token inválido")


def active_call_for(venta_id: str, now: datetime) -> str | None:
    root = calls_root(state.settings.data_dir)
    if not root.exists():
        return None
    window = timedelta(seconds=state.settings.max_call_duration_s + 120)
    for directory in root.iterdir():
        if (directory / "result.json").exists():
            continue
        request = read_json(directory / "request.json") or {}
        if request.get("sale", {}).get("venta_id") != venta_id:
            continue
        if now - datetime.fromisoformat(request["created_at"]) < window:
            return directory.name
    return None


async def start_call(sale: Sale, now: datetime, *, simulacion: bool) -> str:
    """Crea la carpeta de la llamada y despacha el agente a una sala nueva. Devuelve el call_id."""
    if existing := active_call_for(sale.venta_id, now):
        raise HTTPException(status_code=409, detail={"error": "llamada_en_curso", "call_id": existing})

    prefix = "sim" if simulacion else "venta"
    call_id = f"{prefix}-{safe_room_fragment(sale.venta_id)}-{secrets.token_hex(3)}"
    directory = call_dir(state.settings.data_dir, call_id)
    request: dict[str, Any] = {"created_at": now.isoformat(), "sale": sale.to_dict()}
    metadata: dict[str, Any] = {"sale": sale.to_dict()}
    if simulacion:
        request["simulacion"] = metadata["simulacion"] = True
    write_json_atomic(directory / "request.json", request)
    try:
        await state.lkapi.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=state.settings.agent_name,
                room=call_id,
                metadata=json.dumps(metadata),
            )
        )
    except Exception as exc:
        logger.exception("LiveKit no aceptó el despacho", extra={"call_id": call_id})
        (directory / "request.json").unlink(missing_ok=True)
        directory.rmdir()
        raise HTTPException(status_code=502, detail={"error": "livekit_no_disponible"}) from exc
    return call_id


@app.post("/v1/calls", status_code=202, dependencies=[Depends(require_token)])
async def create_call(body: SaleIn) -> dict[str, Any]:
    if not zadarma_configured():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "sin_zadarma",
                "mensaje": "Faltan los datos de Zadarma en .env: por ahora solo funcionan las llamadas simuladas (/prueba).",
            },
        )
    now = utcnow()
    if not state.settings.allow_outside_hours and not is_contact_allowed(now, state.settings.holidays):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "fuera_de_horario",
                "mensaje": "Ley 2300: L-V 7:00-19:00, sábado 8:00-15:00, sin domingos ni festivos (hora de Bogotá).",
            },
        )
    call_id = await start_call(body.to_sale(), now, simulacion=False)
    return {"call_id": call_id, "estado": "marcando"}


@app.post("/v1/simulaciones", status_code=202, dependencies=[Depends(require_token)])
async def create_simulation(body: SimulacionIn) -> dict[str, Any]:
    """Llamada simulada: mismo agente, guion, grabación y resultado, pero el cliente entra por el
    navegador en vez de por Zadarma. No llama a nadie, así que no aplica el horario de la Ley 2300."""
    sale = body.to_sale()
    call_id = await start_call(sale, utcnow(), simulacion=True)
    token = (
        api.AccessToken(state.settings.livekit_api_key, state.settings.livekit_api_secret)
        .with_identity(CLIENT_IDENTITY)
        .with_name(sale.nombre)
        .with_ttl(SIMULATOR_TOKEN_TTL)
        .with_grants(
            api.VideoGrants(
                room_join=True,
                room=call_id,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=False,
                can_publish_sources=["microphone"],
            )
        )
        .to_jwt()
    )
    return {
        "call_id": call_id,
        "estado": "esperando",
        "livekit_url": state.settings.livekit_public_url or None,
        "token": token,
    }


def existing_call_dir(call_id: str) -> tuple[Path, dict[str, Any]]:
    try:
        directory = call_dir(state.settings.data_dir, call_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="call_id inválido") from exc
    request = read_json(directory / "request.json")
    if request is None:
        raise HTTPException(status_code=404, detail="No existe esa llamada")
    return directory, request


@app.get("/v1/calls/{call_id}", dependencies=[Depends(require_token)])
async def get_call(call_id: str) -> dict[str, Any]:
    directory, request = existing_call_dir(call_id)
    result = read_json(directory / "result.json")
    audio = directory / "audio.ogg"
    return {
        "call_id": call_id,
        "venta_id": request["sale"]["venta_id"],
        "simulacion": bool(request.get("simulacion", False)),
        "estado": result["estado"] if result else "en_curso",
        "entregado_a_n8n": (directory / "delivered.json").exists(),
        "grabacion": audio.exists() and audio.stat().st_size > 0,
        "resultado": result,
    }


@app.get("/v1/calls/{call_id}/audio", dependencies=[Depends(require_token)])
async def get_call_audio(call_id: str) -> FileResponse:
    directory, _ = existing_call_dir(call_id)
    audio = directory / "audio.ogg"
    if not audio.exists():
        raise HTTPException(status_code=404, detail="Esa llamada no tiene grabación")
    return FileResponse(audio, media_type="audio/ogg", filename=f"{call_id}.ogg")


@app.get("/prueba", response_class=HTMLResponse, include_in_schema=False)
async def simulator_page() -> HTMLResponse:
    # La página no lleva secretos: pide el DISPATCHER_TOKEN y lo guarda solo en esa pestaña.
    return HTMLResponse(SIMULATOR_PAGE.read_text(encoding="utf-8"), headers={"Cache-Control": "no-store"})


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    try:
        trunks = await state.lkapi.sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"ok": False, "livekit": False}) from exc
    has_trunk = any(t.name == state.settings.trunk_name for t in trunks.items)
    zadarma = zadarma_configured()
    # Sin Zadarma el servicio está sano para simular; con Zadarma, debe existir la troncal.
    return {"ok": has_trunk or not zadarma, "livekit": True, "troncal_sip": has_trunk, "zadarma": zadarma}


@app.post("/internal/calls/{call_id}/done", status_code=202)
async def call_done(
    call_id: str,
    request: Request,
    background: BackgroundTasks,
    x_internal_token: Annotated[str | None, Header()] = None,
) -> dict[str, str]:
    client_host = request.client.host if request.client else ""
    if client_host not in ("127.0.0.1", "::1"):
        raise HTTPException(status_code=403, detail="Solo desde el mismo servidor")
    if not x_internal_token or not hmac.compare_digest(x_internal_token, state.settings.internal_token):
        raise HTTPException(status_code=401, detail="Token interno inválido")
    try:
        call_dir(state.settings.data_dir, call_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="call_id inválido") from exc
    background.add_task(try_deliver, call_id)
    return {"ok": "programado"}
