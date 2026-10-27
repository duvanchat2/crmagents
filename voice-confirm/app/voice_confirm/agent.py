"""Worker de LiveKit Agents: marca al cliente por la troncal SIP de Zadarma y sigue el guion.

Flujo de cada llamada (un "job" por sala):
1. El dispatcher crea la sala y despacha este agente con la venta en `metadata`.
2. El agente arranca la sesión de voz y marca al celular del cliente (SIP, espera a que conteste).
3. AMD (detección de buzón) escucha el primer saludo: si es un buzón, cuelga.
4. Si es una persona, dice el saludo fijo y el modelo sigue el guion con 4 herramientas.
5. Al colgar, copia la grabación y escribe result.json; el dispatcher entrega a n8n.

En una simulación (metadata "simulacion": true) no se marca: el "cliente" entra a la sala desde
el navegador (/prueba del dispatcher) y el resto del flujo es idéntico.

Ejecutar:  python -m voice_confirm.agent start
"""

from __future__ import annotations

import asyncio
import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from google.protobuf.duration_pb2 import Duration
from livekit import api, rtc
from livekit.agents import (
    AMD,
    Agent,
    AgentServer,
    AgentSession,
    JobContext,
    JobProcess,
    RunContext,
    cli,
    function_tool,
    get_job_context,
    room_io,
)
from livekit.plugins import assemblyai, silero

from .config import AgentModels, Settings
from .domain import (
    CLIENT_IDENTITY,
    GOODBYE_REVIEW,
    CallStatus,
    Sale,
    build_instructions,
    digits_only,
    evaluate,
    greeting_text,
    status_from_sip_code,
)
from .outbox import call_dir, utcnow, write_json_atomic

logger = logging.getLogger("genix.confirmacion")

_trunk_cache: dict[str, str] = {}
SIM_JOIN_TIMEOUT_S = 120  # tiempo para que el navegador entre a la sala
SIM_MIC_TIMEOUT_S = 10  # tiempo para que el navegador publique el micrófono


@dataclass
class CallState:
    cedula_intentos: int = 0
    cedula_dicha: str | None = None
    cedula_coincide: bool | None = None
    confirma_condiciones: bool | None = None
    dijo_acepto: bool | None = None
    frase_aceptacion: str | None = None
    motivo_fin: str | None = None
    status_override: CallStatus | None = None
    contestada: datetime | None = None
    simulacion: bool = False


async def hangup() -> None:
    ctx = get_job_context()
    await ctx.api.room.delete_room(api.DeleteRoomRequest(room=ctx.room.name))


class ConfirmacionAgent(Agent):
    def __init__(self, sale: Sale, state: CallState) -> None:
        super().__init__(instructions=build_instructions(sale))
        self._sale = sale
        self._state = state

    @function_tool
    async def registrar_cedula(self, context: RunContext, cedula: str) -> str:
        """Registra la cédula que dijo el cliente.

        Args:
            cedula: Solo los dígitos de la cédula que dijo el cliente, sin puntos ni espacios.
        """
        s = self._state
        s.cedula_intentos += 1
        dicha = digits_only(cedula)
        s.cedula_dicha = dicha
        if dicha and dicha == self._sale.cedula:
            s.cedula_coincide = True
            return "La cédula coincide. Sigue con el paso 2: lee las condiciones exactamente como están escritas."
        if s.cedula_intentos < 2:
            return (
                "La cédula no coincide con la inscripción. Pide con amabilidad que la repita despacio, "
                "dígito por dígito. No digas cuál es la cédula registrada."
            )
        s.cedula_coincide = False
        return f'La cédula sigue sin coincidir. Di exactamente: "{GOODBYE_REVIEW}" y llama a terminar_llamada con motivo "cedula_no_coincide".'

    @function_tool
    async def registrar_confirmacion(self, context: RunContext, confirma: bool) -> str:
        """Registra si el cliente confirmó el programa, el valor y las cuotas.

        Args:
            confirma: true si dijo que sí; false si dijo que no o no está de acuerdo con algo.
        """
        self._state.confirma_condiciones = confirma
        if confirma:
            return "Confirmó. Sigue con el paso 3: pide la frase de aceptación exactamente como está escrita."
        return f'No confirmó. Di exactamente: "{GOODBYE_REVIEW}" y llama a terminar_llamada con motivo "no_confirma".'

    @function_tool
    async def registrar_aceptacion(self, context: RunContext, acepta: bool, frase: str) -> str:
        """Registra si el cliente dijo en voz alta que acepta la compra.

        Args:
            acepta: true solo si dijo que acepta la compra.
            frase: Lo que dijo el cliente, tal como lo dijo.
        """
        self._state.dijo_acepto = acepta
        self._state.frase_aceptacion = frase[:300]
        if acepta:
            return "Aceptó. Di la despedida de matrícula confirmada exactamente como está escrita y llama a terminar_llamada."
        return f'No aceptó. Di exactamente: "{GOODBYE_REVIEW}" y llama a terminar_llamada con motivo "no_acepta".'

    @function_tool
    async def terminar_llamada(self, context: RunContext, motivo: str) -> None:
        """Cuelga la llamada. Úsala después de despedirte, o sin hablar si es un buzón de voz.

        Args:
            motivo: completada, buzon, cliente_no_continua, cedula_no_coincide, no_confirma, no_acepta o pregunta_fuera_de_guion.
        """
        self._state.motivo_fin = motivo
        if motivo == "buzon":
            self._state.status_override = "buzon"
        await context.wait_for_playout()
        await hangup()


def build_stt(m: AgentModels) -> assemblyai.STT:
    kwargs: dict[str, Any] = {}
    if m.stt_max_turn_silence_ms:
        kwargs["max_turn_silence"] = m.stt_max_turn_silence_ms
    if not m.stt_model.startswith("universal-streaming"):
        kwargs["language_codes"] = ["es"]
    return assemblyai.STT(api_key=m.assemblyai_api_key, model=m.stt_model, **kwargs)


def build_llm(m: AgentModels) -> Any:
    if m.llm_provider == "anthropic":
        from livekit.plugins import anthropic

        return anthropic.LLM(model=m.llm_model, api_key=m.anthropic_api_key)

    from livekit.plugins import openai

    kwargs: dict[str, Any] = {}
    if m.llm_reasoning == "off":
        kwargs["extra_body"] = {"reasoning": {"enabled": False}}
    elif m.llm_reasoning == "low":
        kwargs["extra_body"] = {"reasoning": {"effort": "low"}}
    return openai.LLM(
        model=m.llm_model,
        base_url="https://openrouter.ai/api/v1",
        api_key=m.openrouter_api_key,
        **kwargs,
    )


def build_tts(m: AgentModels) -> Any:
    if m.tts_provider == "elevenlabs":
        from livekit.plugins import elevenlabs

        return elevenlabs.TTS(
            api_key=m.elevenlabs_api_key,
            voice_id=m.elevenlabs_voice_id,
            model=m.elevenlabs_model,
            language="es",
        )
    from livekit.plugins import fishaudio

    return fishaudio.TTS(api_key=m.fish_api_key, model=m.fish_model, voice_id=m.fish_voice_id)


async def resolve_trunk_id(lkapi: api.LiveKitAPI, trunk_name: str) -> str:
    if trunk_name in _trunk_cache:
        return _trunk_cache[trunk_name]
    resp = await lkapi.sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
    for trunk in resp.items:
        if trunk.name == trunk_name:
            _trunk_cache[trunk_name] = trunk.sip_trunk_id
            return trunk.sip_trunk_id
    raise RuntimeError(
        f"No existe la troncal SIP '{trunk_name}'. Ejecute: docker compose run --rm dispatcher python -m voice_confirm.trunk"
    )


def transcript(session: AgentSession | None) -> list[dict[str, str]]:
    if session is None:
        return []
    lines: list[dict[str, str]] = []
    for item in session.history.items:
        if getattr(item, "type", None) != "message" or item.role not in ("user", "assistant"):
            continue
        text = (item.text_content or "").strip()
        if text:
            lines.append({"rol": "cliente" if item.role == "user" else "agente", "texto": text})
    return lines


async def wait_for_microphone(room: rtc.Room, identity: str, timeout: float) -> None:
    """Espera a que el navegador publique su micrófono: así el saludo no se pierde mientras conecta."""
    participant = room.remote_participants.get(identity)
    if participant and any(p.kind == rtc.TrackKind.KIND_AUDIO for p in participant.track_publications.values()):
        return
    published: asyncio.Future[None] = asyncio.get_running_loop().create_future()

    def on_published(publication: rtc.RemoteTrackPublication, p: rtc.RemoteParticipant) -> None:
        if p.identity == identity and publication.kind == rtc.TrackKind.KIND_AUDIO and not published.done():
            published.set_result(None)

    room.on("track_published", on_published)
    try:
        await asyncio.wait_for(published, timeout)
    except asyncio.TimeoutError:
        logger.warning("el navegador no publicó el micrófono a tiempo; se saluda igual")
    finally:
        room.off("track_published", on_published)


async def answer_simulation(ctx: JobContext, settings: Settings, state: CallState) -> bool:
    """Simulación: en vez de marcar, espera al "cliente" del navegador. False si nunca entró."""
    try:
        await asyncio.wait_for(ctx.wait_for_participant(identity=CLIENT_IDENTITY), SIM_JOIN_TIMEOUT_S)
    except asyncio.TimeoutError:
        state.status_override = "no_contesta"
        state.motivo_fin = "simulacion_sin_participante"
        ctx.shutdown(reason=state.motivo_fin)
        return False
    await wait_for_microphone(ctx.room, CLIENT_IDENTITY, SIM_MIC_TIMEOUT_S)
    await asyncio.sleep(0.5)  # margen para que el navegador termine de suscribirse al audio del agente
    state.contestada = utcnow()

    # En una llamada real el límite lo pone max_call_duration del SIP; aquí se cuelga a mano.
    async def limit_duration() -> None:
        await asyncio.sleep(settings.max_call_duration_s)
        state.motivo_fin = state.motivo_fin or "duracion_maxima"
        await hangup()

    limiter = asyncio.create_task(limit_duration())

    async def cancel_limiter() -> None:
        limiter.cancel()

    ctx.add_shutdown_callback(cancel_limiter)
    return True


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load()


server = AgentServer(setup_fnc=prewarm, shutdown_process_timeout=30.0)
_agent_name = Settings.agent_name_from_env()


@server.rtc_session(agent_name=_agent_name)
async def entrypoint(ctx: JobContext) -> None:
    settings = Settings.load()
    models = AgentModels.load()
    payload = json.loads(ctx.job.metadata or "{}")
    sale = Sale.from_dict(payload["sale"])
    call_id = ctx.room.name
    state = CallState(simulacion=bool(payload.get("simulacion", False)))
    holder: dict[str, AgentSession] = {}

    async def on_shutdown(reason: str) -> None:
        await finalize(ctx, settings, call_id, sale, state, holder.get("session"), reason)

    ctx.add_shutdown_callback(on_shutdown)
    await ctx.connect()

    trunk_id = ""
    if not state.simulacion:
        try:
            trunk_id = await resolve_trunk_id(ctx.api, settings.trunk_name)
        except Exception:
            logger.exception("no se encontró la troncal SIP")
            state.status_override = "fallida"
            state.motivo_fin = "sin_troncal_sip"
            ctx.shutdown(reason="sin_troncal_sip")
            return

    session: AgentSession = AgentSession(
        stt=build_stt(models),
        llm=build_llm(models),
        tts=build_tts(models),
        vad=ctx.proc.userdata["vad"],
        turn_handling={"turn_detection": "stt"},
    )
    holder["session"] = session
    await session.start(
        ConfirmacionAgent(sale, state),
        room=ctx.room,
        room_options=room_io.RoomOptions(
            participant_identity=CLIENT_IDENTITY,
            close_on_disconnect=True,
            delete_room_on_close=True,
        ),
        # Graba cliente + agente en un solo audio.ogg dentro de la carpeta temporal del job.
        # Sin LiveKit Cloud no se sube a ningún lado: finalize() lo copia a DATA_DIR.
        record={"audio": True, "traces": False, "logs": False, "transcript": False},
    )

    if state.simulacion:
        if await answer_simulation(ctx, settings, state):
            await session.say(greeting_text(), allow_interruptions=False)
        return

    try:
        async with AMD(
            session,
            llm=None,  # reutiliza el LLM de la sesión
            stt=None,  # reutiliza las transcripciones de la sesión
            participant_identity=CLIENT_IDENTITY,
            ivr_detection=False,
            suppress_compatibility_warning=True,
        ) as detector:
            await ctx.api.sip.create_sip_participant(
                api.CreateSIPParticipantRequest(
                    room_name=call_id,
                    sip_trunk_id=trunk_id,
                    sip_call_to=sale.telefono,
                    participant_identity=CLIENT_IDENTITY,
                    participant_name=sale.nombre,
                    wait_until_answered=True,
                    ringing_timeout=Duration(seconds=settings.ringing_timeout_s),
                    max_call_duration=Duration(seconds=settings.max_call_duration_s),
                )
            )
            state.contestada = utcnow()
            verdict = await detector.execute()
    except api.SipCallError as exc:
        state.status_override = status_from_sip_code(exc.sip_status_code)
        state.motivo_fin = f"sip_{exc.sip_status_code or 'error'}"
        logger.info("no se completó el marcado", extra={"call_id": call_id, "sip": exc.sip_status_code})
        ctx.shutdown(reason=state.motivo_fin)
        return
    except Exception:
        logger.exception("error al marcar", extra={"call_id": call_id})
        state.status_override = "fallida"
        state.motivo_fin = "error_al_marcar"
        ctx.shutdown(reason="error_al_marcar")
        return

    if verdict.is_machine:
        state.status_override = "buzon"
        state.motivo_fin = str(verdict.category.value)
        await hangup()
        return

    await session.say(greeting_text(), allow_interruptions=False)


async def finalize(
    ctx: JobContext,
    settings: Settings,
    call_id: str,
    sale: Sale,
    state: CallState,
    session: AgentSession | None,
    reason: str,
) -> None:
    """Corre al cerrar el job: debe ser rápido (copiar y escribir); la entrega la hace el dispatcher."""
    directory = call_dir(settings.data_dir, call_id)
    if state.status_override:
        estado: CallStatus = state.status_override
    elif state.contestada is None:
        estado = "fallida"
    else:
        estado = evaluate(
            cedula_coincide=state.cedula_coincide,
            confirma_condiciones=state.confirma_condiciones,
            dijo_acepto=state.dijo_acepto,
        )

    try:
        recorded = ctx.session_directory / "audio.ogg"
        if state.contestada and recorded.exists():
            directory.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(recorded, directory / "audio.ogg")
    except Exception:
        logger.exception("no se pudo copiar la grabación", extra={"call_id": call_id})

    write_json_atomic(
        directory / "result.json",
        {
            "estado": estado,
            "cedula_dicha": state.cedula_dicha,
            "cedula_coincide": state.cedula_coincide,
            "confirma_condiciones": state.confirma_condiciones,
            "dijo_acepto": state.dijo_acepto,
            "frase_aceptacion": state.frase_aceptacion,
            "simulacion": state.simulacion,
            "motivo_fin": state.motivo_fin or reason,
            "contestada": state.contestada.isoformat() if state.contestada else None,
            "finalizada": utcnow().isoformat(),
            "transcripcion": transcript(session),
        },
    )
    logger.info(
        "llamada finalizada",
        extra={"call_id": call_id, "estado": estado, "venta_id": sale.venta_id, "simulacion": state.simulacion},
    )

    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            await client.post(
                f"http://127.0.0.1:{settings.dispatcher_port}/internal/calls/{call_id}/done",
                headers={"X-Internal-Token": settings.internal_token},
            )
    except Exception:
        # No es grave: el barrido del dispatcher la recoge en menos de un minuto.
        logger.warning("no se pudo avisar al dispatcher", extra={"call_id": call_id})


if __name__ == "__main__":
    cli.run_app(server)
