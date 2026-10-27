"""Configuración leída del entorno (.env). Ningún secreto se imprime ni se escribe en logs."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import date
from pathlib import Path

from .domain import parse_holidays


def _req(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value or value.startswith("REEMPLAZA_"):
        raise RuntimeError(f"Falta la variable de entorno {name} (ver voice-confirm/.env.example)")
    return value


def _opt(name: str, default: str = "") -> str:
    value = os.environ.get(name, "").strip()
    if value.startswith("REEMPLAZA_"):
        return default
    return value or default


def _opt_int(name: str) -> int | None:
    value = _opt(name)
    return int(value) if value else None


def _bool(name: str, default: bool = False) -> bool:
    value = _opt(name)
    if not value:
        return default
    return value.lower() in ("1", "true", "yes", "si", "sí")


@dataclass(frozen=True)
class Settings:
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    agent_name: str
    trunk_name: str
    data_dir: Path
    holidays: set[date]
    allow_outside_hours: bool
    ringing_timeout_s: int
    max_call_duration_s: int
    dispatcher_port: int
    dispatcher_host: str  # dónde escucha el dispatcher (127.0.0.1 o el puente de Docker)
    internal_token: str
    livekit_public_url: str  # para el simulador del navegador; vacío = wss://<dominio de la página>

    @staticmethod
    def agent_name_from_env() -> str:
        return _opt("AGENT_NAME", "genix-confirmacion")

    @classmethod
    def load(cls) -> Settings:
        return cls(
            livekit_url=_opt("LIVEKIT_URL", "ws://127.0.0.1:7880"),
            livekit_api_key=_req("LIVEKIT_API_KEY"),
            livekit_api_secret=_req("LIVEKIT_API_SECRET"),
            agent_name=cls.agent_name_from_env(),
            trunk_name=_opt("SIP_TRUNK_NAME", "zadarma-genix"),
            data_dir=Path(_opt("DATA_DIR", "/data")),
            holidays=parse_holidays(_opt("COLOMBIA_HOLIDAYS")),
            allow_outside_hours=_bool("ALLOW_OUTSIDE_HOURS", False),
            ringing_timeout_s=int(_opt("RINGING_TIMEOUT_S", "30")),
            max_call_duration_s=int(_opt("MAX_CALL_DURATION_S", "300")),
            dispatcher_port=int(_opt("DISPATCHER_PORT", "8088")),
            dispatcher_host=_opt("DISPATCHER_HOST", "127.0.0.1"),
            internal_token=_req("INTERNAL_TOKEN"),
            livekit_public_url=_opt("LIVEKIT_PUBLIC_URL"),
        )


@dataclass(frozen=True)
class AgentModels:
    """Proveedores del agente de voz: oído (STT), cerebro (LLM) y voz (TTS)."""

    assemblyai_api_key: str
    stt_model: str
    stt_max_turn_silence_ms: int | None
    llm_provider: str  # openrouter | anthropic
    llm_model: str
    llm_reasoning: str  # off | low | default (solo OpenRouter)
    openrouter_api_key: str
    anthropic_api_key: str
    tts_provider: str  # fishaudio | elevenlabs
    fish_api_key: str
    fish_model: str
    fish_voice_id: str
    elevenlabs_api_key: str
    elevenlabs_model: str
    elevenlabs_voice_id: str

    @classmethod
    def load(cls) -> AgentModels:
        llm_provider = _opt("LLM_PROVIDER", "openrouter")
        tts_provider = _opt("TTS_PROVIDER", "fishaudio")
        return cls(
            assemblyai_api_key=_req("ASSEMBLYAI_API_KEY"),
            stt_model=_opt("STT_MODEL", "universal-streaming-multilingual"),
            stt_max_turn_silence_ms=_opt_int("STT_MAX_TURN_SILENCE_MS"),
            llm_provider=llm_provider,
            llm_model=_opt(
                "LLM_MODEL",
                "anthropic/claude-haiku-5.5" if llm_provider == "openrouter" else "claude-haiku-5-5",
            ),
            llm_reasoning=_opt("LLM_REASONING", "off"),
            openrouter_api_key=_req("OPENROUTER_API_KEY") if llm_provider == "openrouter" else "",
            anthropic_api_key=_req("ANTHROPIC_API_KEY") if llm_provider == "anthropic" else "",
            tts_provider=tts_provider,
            fish_api_key=_req("FISH_API_KEY") if tts_provider == "fishaudio" else "",
            fish_model=_opt("FISH_MODEL", "s2.1-pro"),
            fish_voice_id=_req("FISH_VOICE_ID") if tts_provider == "fishaudio" else "",
            elevenlabs_api_key=_req("ELEVEN_API_KEY") if tts_provider == "elevenlabs" else "",
            elevenlabs_model=_opt("ELEVEN_MODEL", "eleven_flash_v2_5"),
            elevenlabs_voice_id=_req("ELEVEN_VOICE_ID") if tts_provider == "elevenlabs" else "",
        )


@dataclass(frozen=True)
class DeliverySettings:
    """A dónde van el resultado y la grabación cuando termina la llamada."""

    n8n_webhook_url: str  # vacío = el resultado queda solo en el VPS (útil para probar sin n8n)
    n8n_webhook_secret: str
    bunny_storage_zone: str
    bunny_storage_key: str
    bunny_storage_host: str
    bunny_path_prefix: str
    bunny_pull_zone_url: str
    local_retention_days: int

    @property
    def bunny_enabled(self) -> bool:
        return bool(self.bunny_storage_zone and self.bunny_storage_key)

    @classmethod
    def load(cls) -> DeliverySettings:
        return cls(
            n8n_webhook_url=_opt("N8N_RESULT_WEBHOOK_URL"),
            n8n_webhook_secret=_req("N8N_WEBHOOK_SECRET"),
            bunny_storage_zone=_opt("BUNNY_STORAGE_ZONE"),
            bunny_storage_key=_opt("BUNNY_STORAGE_PASSWORD"),
            bunny_storage_host=_opt("BUNNY_STORAGE_HOST", "storage.bunnycdn.com"),
            bunny_path_prefix=_opt("BUNNY_PATH_PREFIX", "grabaciones-confirmacion").strip("/"),
            bunny_pull_zone_url=_opt("BUNNY_PULL_ZONE_URL").rstrip("/"),
            local_retention_days=int(_opt("LOCAL_RETENTION_DAYS", "30")),
        )


def dispatcher_token() -> str:
    return _req("DISPATCHER_TOKEN")


ZADARMA_VARS = ("ZADARMA_SIP_USER", "ZADARMA_SIP_PASSWORD", "ZADARMA_CALLER_NUMBER")


def zadarma_configured() -> bool:
    """Sin Zadarma el servicio solo hace llamadas simuladas desde el navegador (/prueba)."""
    return all(_opt(name) for name in ZADARMA_VARS)


@dataclass(frozen=True)
class TrunkSettings:
    """Datos de la extensión de la centralita de Zadarma que usa LiveKit para marcar."""

    host: str
    username: str
    password: str
    caller_number: str

    @classmethod
    def load(cls) -> TrunkSettings:
        return cls(
            host=_opt("ZADARMA_SIP_HOST", "pbx.zadarma.com"),
            username=_req("ZADARMA_SIP_USER"),
            password=_req("ZADARMA_SIP_PASSWORD"),
            caller_number=_req("ZADARMA_CALLER_NUMBER"),
        )
