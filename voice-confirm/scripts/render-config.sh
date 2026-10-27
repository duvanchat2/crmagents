#!/usr/bin/env bash
# Genera ./generated/{livekit.yaml,sip.yaml,Caddyfile} reemplazando ${VAR} con los valores de .env.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Falta .env (copie .env.example)"; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a

mkdir -p generated
chmod 700 generated

render() {
  perl -pe 's/\$\{(\w+)\}/exists $ENV{$1} ? $ENV{$1} : $&/ge' "$1" > "$2"
  chmod 600 "$2"
}

render config/livekit.yaml.tmpl generated/livekit.yaml
render config/sip.yaml.tmpl generated/sip.yaml
if [ -n "${DISPATCHER_DOMAIN:-}" ]; then
  render config/Caddyfile.tmpl generated/Caddyfile
fi

if grep -q '\${' generated/livekit.yaml generated/sip.yaml; then
  echo "Quedaron variables sin reemplazar en ./generated (revise .env)"
  exit 1
fi
echo "Configuración generada en ./generated"
