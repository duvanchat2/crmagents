#!/usr/bin/env bash
# Verifica que todo esté arriba. No imprime secretos. Sale con código 1 si algo falla.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
set -a
# shellcheck disable=SC1091
. ./.env
set +a

ok=0
is_set() { local v="${!1:-}"; [ -n "$v" ] && [[ "$v" != REEMPLAZA_* ]]; }
with_zadarma=0
is_set ZADARMA_SIP_USER && is_set ZADARMA_SIP_PASSWORD && is_set ZADARMA_CALLER_NUMBER && with_zadarma=1

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
if [ "$with_zadarma" = 1 ]; then
  check "Dispatcher + troncal SIP (/healthz)" sh -c "curl -fsS http://127.0.0.1:${DISPATCHER_PORT:-8088}/healthz | grep -q '\"troncal_sip\":true'"
else
  check "Dispatcher + LiveKit (/healthz)" sh -c "curl -fsS http://127.0.0.1:${DISPATCHER_PORT:-8088}/healthz | grep -q '\"livekit\":true'"
  printf '  \033[33mAVISO\033[0m Sin Zadarma: modo simulación (solo llamadas de prueba desde el navegador)\n'
fi
check "Agente registrado en LiveKit" sh -c "docker compose logs --since 30m agent 2>&1 | grep -qi 'registered worker'"
check "Puerto SIP 5060/udp escuchando" sh -c "ss -H -ulnp | grep -q ':5060 '"
if [ -n "${DISPATCHER_DOMAIN:-}" ]; then
  check "Simulador por HTTPS (https://${DISPATCHER_DOMAIN}/prueba)" curl -fsS "https://${DISPATCHER_DOMAIN}/prueba"
fi

echo
public_ip="$(curl -fsS https://api.ipify.org 2>/dev/null || echo 'desconocida')"
echo "IP pública del VPS: ${public_ip}"
echo "Desde Internet deben estar abiertos: 5060 UDP/TCP y 10000-20000 UDP (para Zadarma)."
if [ -n "${DISPATCHER_DOMAIN:-}" ]; then
  echo "Para el simulador del navegador, además: 80/443 TCP, 7881 TCP y 50000-50100 UDP."
fi
echo "Deben estar cerrados: ${REDIS_PORT:-6380} (Redis), 7880 y 8088."
exit "$ok"
