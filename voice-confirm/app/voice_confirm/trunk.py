"""Crea o actualiza la troncal SIP de salida (Zadarma) en LiveKit. Idempotente.

Ejecutar:  docker compose run --rm dispatcher python -m voice_confirm.trunk
"""

from __future__ import annotations

import asyncio
import sys

from livekit import api

from .config import Settings, TrunkSettings


async def ensure_trunk() -> str:
    settings = Settings.load()
    trunk = TrunkSettings.load()
    async with api.LiveKitAPI(settings.livekit_url, settings.livekit_api_key, settings.livekit_api_secret) as lkapi:
        existing = await lkapi.sip.list_outbound_trunk(api.ListSIPOutboundTrunkRequest())
        for item in existing.items:
            if item.name == settings.trunk_name:
                await lkapi.sip.update_outbound_trunk_fields(
                    item.sip_trunk_id,
                    address=trunk.host,
                    numbers=[trunk.caller_number],
                    auth_username=trunk.username,
                    auth_password=trunk.password,
                )
                return item.sip_trunk_id
        created = await lkapi.sip.create_outbound_trunk(
            api.CreateSIPOutboundTrunkRequest(
                trunk=api.SIPOutboundTrunkInfo(
                    name=settings.trunk_name,
                    address=trunk.host,
                    numbers=[trunk.caller_number],
                    auth_username=trunk.username,
                    auth_password=trunk.password,
                )
            )
        )
        return created.sip_trunk_id


def main() -> int:
    trunk_id = asyncio.run(ensure_trunk())
    print(f"Troncal SIP lista: {trunk_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
