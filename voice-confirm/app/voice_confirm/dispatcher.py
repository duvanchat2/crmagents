"""API HTTP que usa n8n para pedir llamadas, y entrega de resultados a n8n.

  POST /v1/calls             n8n pide una llamada (Bearer DISPATCHER_TOKEN)
  GET  /v1/calls/{call_id}   estado de una llamada (Bearer DISPATCHER_TOKEN)
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
from typing import Annotated, Any

import httpx
from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException, Request
from livekit import api
from pydantic import BaseModel, Field, field_validator

from .config import DeliverySettings, Settings, dispatcher_token
from .domain import (
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


@app.post("/v1/calls", status_code=202, dependencies=[Depends(require_token)])
async def create_call(body: SaleIn) -> dict[str, Any]:
    now = utcnow()
    if not state.settings.allow_outside_hours and not is_contact_allowed(now, state.settings.holidays):
        raise HTTPException(
            status_code=409,
            detail={
                "error": "fuera_de_horario",
                "mensaje": "Ley 2300: L-V 7:00-19:00, sábado 8:00-15:00, sin domingos ni festivos (hora de Bogotá).",
            },
        )
    sale = body.to_sale()
    if existing := active_call_for(sale.venta_id, now):
        raise HTTPException(status_code=409, detail={"error": "llamada_en_curso", "call_id": existing})

    call_id = f"venta-{safe_room_fragment(sale.venta_id)}-{secrets.token_hex(3)}"
    directory = call_dir(state.settings.data_dir, call_id)
    write_json_atomic(directory / "request.json", {"created_at": now.isoformat(), "sale": sale.to_dict()})
    try:
        await state.lkapi.agent_dispatch.create_dispatch(
            api.CreateAgentDispatchRequest(
                agent_name=state.settings.agent_name,
                room=call_id,
                metadata=json.dumps({"sale": sale.to_dict()}),
            )
        )
    except Exception as exc:
        logger.exception("LiveKit no aceptó el despacho", extra={"call_id": call_id})
        (directory / "request.json").unlink(missing_ok=True)
        directory.rmdir()
        raise HTTPException(status_code=502, detail={"error": "livekit_no_disponible"}) from exc
    return {"call_id": call_id, "estado": "marcando"}


@app.get("/v1/calls/{call_id}", dependencies=[Depends(require_token)])
async def get_call(call_id: str) -> dict[str, Any]:
    try:
        directory = call_dir(state.settings.data_dir, call_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="call_id inválido") from exc
    request = read_json(directory / "request.json")
    if request is None:
        raise HTTPException(status_code=404, detail="No existe esa llamada")
    result = read_json(directory / "result.json")
    return {
        "call_id": call_id,
        "venta_id": request["sale"]["venta_id"],
        "estado": result["estado"] if result else "en_curso",
        "entregado_a_n8n": (directory / "delivered.json").exists(),
    }


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    try:
        trunks = await state.lkapi.sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
    except Exception as exc:
        raise HTTPException(status_code=503, detail={"ok": False, "livekit": False}) from exc
    has_trunk = any(t.name == state.settings.trunk_name for t in trunks.items)
    return {"ok": has_trunk, "livekit": True, "troncal_sip": has_trunk}


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
