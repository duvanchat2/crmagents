#!/usr/bin/env bash
# Imprime el enlace del simulador con el DISPATCHER_TOKEN ya incluido (va después de "#",
# así que el navegador no lo manda al servidor ni queda en logs).
#
#   ./scripts/sim-link.sh
#
# El enlace da acceso al dispatcher: ábralo usted y no lo comparta. Un agente no debe
# correr este script ni copiar su salida a un chat.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a

[ -n "${DISPATCHER_DOMAIN:-}" ] || { echo "Falta DISPATCHER_DOMAIN en .env (el simulador necesita HTTPS)."; exit 1; }
[[ "${DISPATCHER_TOKEN:-}" != REEMPLAZA_* && -n "${DISPATCHER_TOKEN:-}" ]] || { echo "Falta DISPATCHER_TOKEN: corra sudo ./scripts/bootstrap.sh"; exit 1; }
echo "https://${DISPATCHER_DOMAIN}/prueba#t=${DISPATCHER_TOKEN}"
