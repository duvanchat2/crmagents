#!/usr/bin/env bash
# Verifica que todo esté arriba. No imprime secretos. Sale con código 1 si algo falla.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
set -a
# shellcheck disable=SC1091
. ./.env
set +a

ok=0
check() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then
    printf '  \033[32mOK\033[0m   %s\n' "$name"
  else
    printf '  \033[31mFALLA\033[0m %s\n' "$name"
    ok=1
  fi
}

echo "Contenedores:"
docker compose ps --format 'table {{.Service}}\t{{.State}}\t{{.Status}}'

echo
echo "Servicios:"
check "LiveKit responde (127.0.0.1:7880)" curl -fsS http://127.0.0.1:7880
check "Servicio SIP sano (127.0.0.1:8089)" curl -fsS http://127.0.0.1:8089
check "Dispatcher + troncal SIP (/healthz)" sh -c "curl -fsS http://127.0.0.1:${DISPATCHER_PORT:-8088}/healthz | grep -q '\"troncal_sip\":true'"
check "Agente registrado en LiveKit" sh -c "docker compose logs --since 30m agent 2>&1 | grep -qi 'registered worker'"
check "Puerto SIP 5060/udp escuchando" sh -c "ss -H -ulnp | grep -q ':5060 '"

echo
public_ip="$(curl -fsS https://api.ipify.org 2>/dev/null || echo 'desconocida')"
echo "IP pública del VPS: ${public_ip}"
echo "Desde Internet deben estar abiertos: 5060 UDP/TCP y 10000-20000 UDP (para Zadarma)."
echo "Deben estar cerrados: 6379, 7880, 7881, 8088 y 50000-50100."
exit "$ok"
