#!/usr/bin/env bash
# Llamada de prueba a un celular propio con una venta de ejemplo, y espera el resultado.
#
#   ./scripts/test-call.sh +573001234567 "Nombre Apellido" 1234567890
#
# Cada llamada gasta minutos de Zadarma y del agente. Úsela con números propios.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a
# shellcheck disable=SC1091
. ./.env
set +a

phone="${1:?Uso: $0 <celular> <nombre> <cedula>}"
name="${2:?Falta el nombre}"
cedula="${3:?Falta la cédula}"
base="http://127.0.0.1:${DISPATCHER_PORT:-8088}"
today_plus_10="$(date -d '+10 days' +%F 2>/dev/null || date -v+10d +%F)"

body=$(cat <<JSON
{
  "venta_id": "PRUEBA-$(date +%s)",
  "telefono": "${phone}",
  "nombre": "${name}",
  "cedula": "${cedula}",
  "programa": "Inteligencia Artificial para Empresas",
  "contenido": "cuarenta horas de clases y certificado",
  "valor_total": 480000,
  "numero_cuotas": 6,
  "valor_cuota": 80000,
  "fecha_primera_cuota": "${today_plus_10}",
  "asesor": "Prueba"
}
JSON
)

echo "Pidiendo la llamada..."
resp="$(curl -sS -X POST "${base}/v1/calls" \
  -H "Authorization: Bearer ${DISPATCHER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "${body}")"
echo "${resp}"
call_id="$(echo "${resp}" | sed -nE 's/.*"call_id":"([^"]+)".*/\1/p')"
[ -n "${call_id}" ] || { echo "No se creó la llamada."; exit 1; }

echo "Esperando el resultado de ${call_id} (máx. 7 min)..."
for _ in $(seq 1 84); do
  status="$(curl -sS "${base}/v1/calls/${call_id}" -H "Authorization: Bearer ${DISPATCHER_TOKEN}")"
  if ! echo "${status}" | grep -q '"estado":"en_curso"'; then
    echo "${status}"
    echo "Detalle: data/calls/${call_id}/result.json   Grabación: data/calls/${call_id}/audio.ogg"
    exit 0
  fi
  sleep 5
done
echo "Sin resultado a tiempo. Revise: docker compose logs --since 10m agent sip"
exit 1
