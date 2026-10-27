#!/usr/bin/env bash
# Instala y levanta todo en el VPS. Idempotente: se puede correr las veces que haga falta.
#
#   sudo ./scripts/bootstrap.sh            instala/actualiza y levanta
#   sudo FORCE_UFW=1 ./scripts/bootstrap.sh   activa el firewall aunque haya otros servicios expuestos
#
# Qué hace:
#   1. Instala Docker si falta.
#   2. Genera las claves internas que sigan en REEMPLAZA_ dentro de .env.
#   3. Verifica que estén las credenciales externas (AssemblyAI, LLM, voz; Zadarma y n8n opcionales).
#      Sin Zadarma queda en "modo simulación": solo llamadas de prueba desde el navegador (/prueba).
#   4. Genera la configuración de LiveKit y del servicio SIP.
#   5. Abre en el firewall solo lo necesario (SSH, SIP 5060, audio 10000-20000/udp y, con dominio,
#      80/443 y el audio del simulador 7881/tcp y 50000-50100/udp).
#   6. Construye la imagen, levanta LiveKit, crea la troncal de Zadarma (si hay) y levanta el agente.
#   7. Corre scripts/check.sh.
set -euo pipefail
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "Ejecute como root: sudo ./scripts/bootstrap.sh"

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  echo "Se creó .env desde .env.example."
fi
chmod 600 .env

# ---------- 1. Docker ----------
say "Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || fail "Falta el plugin 'docker compose'."
command -v perl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y perl; }
command -v openssl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y openssl; }
command -v curl >/dev/null 2>&1 || { apt-get update -y && apt-get install -y curl; }
docker --version

# ---------- 2. Claves internas ----------
say "Claves internas"
set_if_placeholder() {
  local key="$1" value="$2"
  if grep -qE "^${key}=(REEMPLAZA_.*)?$" .env; then
    sed -i "s|^${key}=.*|${key}=${value}|" .env
    echo "  generada: ${key}"
  fi
}
set_if_placeholder LIVEKIT_API_KEY "API$(openssl rand -hex 6)"
set_if_placeholder LIVEKIT_API_SECRET "$(openssl rand -hex 32)"
set_if_placeholder REDIS_PASSWORD "$(openssl rand -hex 24)"
set_if_placeholder INTERNAL_TOKEN "$(openssl rand -hex 32)"
set_if_placeholder DISPATCHER_TOKEN "$(openssl rand -hex 32)"
set_if_placeholder N8N_WEBHOOK_SECRET "$(openssl rand -hex 32)"

set -a
# shellcheck disable=SC1091
. ./.env
set +a

# ---------- 3. Credenciales externas ----------
say "Credenciales externas"
is_set() { local v="${!1:-}"; [ -n "$v" ] && [[ "$v" != REEMPLAZA_* ]]; }

required=(ASSEMBLYAI_API_KEY)
zadarma_vars=(ZADARMA_SIP_USER ZADARMA_SIP_PASSWORD ZADARMA_CALLER_NUMBER)
zadarma_count=0
for key in "${zadarma_vars[@]}"; do is_set "$key" && zadarma_count=$((zadarma_count + 1)); done
# Los tres o ninguno: ninguno = modo simulación; a medias es un error de configuración.
if [ "$zadarma_count" -gt 0 ]; then
  required+=("${zadarma_vars[@]}")
fi
case "${LLM_PROVIDER:-openrouter}" in
  anthropic) required+=(ANTHROPIC_API_KEY) ;;
  *) required+=(OPENROUTER_API_KEY) ;;
esac
case "${TTS_PROVIDER:-fishaudio}" in
  elevenlabs) required+=(ELEVEN_API_KEY ELEVEN_VOICE_ID) ;;
  *) required+=(FISH_API_KEY FISH_VOICE_ID) ;;
esac
missing=()
for key in "${required[@]}"; do
  is_set "$key" || missing+=("$key")
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Faltan estas variables en $(pwd)/.env (vea la guía en cada línea):"
  printf '  - %s\n' "${missing[@]}"
  exit 2
fi
echo "  completas"
if [ "$zadarma_count" -gt 0 ]; then
  [[ "$ZADARMA_CALLER_NUMBER" == +57* ]] || fail "ZADARMA_CALLER_NUMBER debe ir en formato +57..."
  with_zadarma=1
else
  with_zadarma=0
  echo "  Sin Zadarma: MODO SIMULACIÓN. Solo funcionan las llamadas de prueba desde el navegador (/prueba)."
  echo "  Cuando tenga la extensión y el 601, complete ZADARMA_* y vuelva a correr este script."
fi
if ! is_set N8N_RESULT_WEBHOOK_URL; then
  echo "  Sin N8N_RESULT_WEBHOOK_URL: los resultados quedan solo en el VPS (data/calls/)."
fi

# ---------- 4. Configuración ----------
say "Configuración de LiveKit y SIP"
./scripts/render-config.sh
mkdir -p data
chown -R 10001:10001 data
chmod 750 data

# ---------- 5. Firewall ----------
say "Firewall"
ssh_port="22"
if [ -n "${SSH_CONNECTION:-}" ]; then
  ssh_port="$(echo "$SSH_CONNECTION" | awk '{print $4}')"
fi
if command -v ufw >/dev/null 2>&1; then
  ufw allow "${ssh_port}/tcp" >/dev/null
  ufw allow 5060/udp >/dev/null
  ufw allow 5060/tcp >/dev/null
  ufw allow 10000:20000/udp >/dev/null
  if [ -n "${DISPATCHER_DOMAIN:-}" ]; then
    ufw allow 80/tcp >/dev/null
    ufw allow 443/tcp >/dev/null
    # Audio del simulador del navegador (WebRTC). La API de LiveKit (7880) sigue cerrada.
    ufw allow 7881/tcp >/dev/null
    ufw allow 50000:50100/udp >/dev/null
  fi
  if [ -n "${N8N_ALLOWED_IP:-}" ] && [ "${DISPATCHER_HOST:-127.0.0.1}" != "127.0.0.1" ]; then
    ufw allow from "$N8N_ALLOWED_IP" to any port "${DISPATCHER_PORT:-8088}" proto tcp >/dev/null
  fi
  if ufw status | grep -q "Status: active"; then
    echo "  ufw ya estaba activo; reglas añadidas."
  else
    # Antes de activar, ver si hay otros servicios expuestos que el firewall cortaría.
    # Se ignoran los puertos de este mismo servicio (SIP, audio, LiveKit, dispatcher).
    exposed="$(ss -H -tlnu 2>/dev/null | awk '{print $5}' | grep -vE '^(127\.|\[::1\]|::1)' \
      | sed -E 's/.*:([0-9]+)$/\1/' | sort -un \
      | awk -v ssh="$ssh_port" -v disp="${DISPATCHER_PORT:-8088}" '
          $1==ssh || $1==5060 || $1==80 || $1==443 || $1==7880 || $1==7881 || $1==8089 || $1==disp { next }
          ($1>=10000 && $1<=20000) || ($1>=50000 && $1<=60999) { next }
          { print }' || true)"
    if [ -n "$exposed" ] && [ "${FORCE_UFW:-0}" != "1" ]; then
      echo "  ATENCIÓN: ufw está inactivo y hay otros puertos escuchando hacia afuera:"
      echo "$exposed" | sed 's/^/    - /'
      echo "  No lo activo para no cortar esos servicios. Ábralos con 'ufw allow <puerto>' y"
      echo "  vuelva a correr con FORCE_UFW=1, o active ufw a mano."
    else
      ufw --force enable >/dev/null
      echo "  ufw activado (SSH ${ssh_port}, SIP 5060, audio 10000-20000/udp${DISPATCHER_DOMAIN:+, 80/443, simulador 7881/tcp y 50000-50100/udp})."
    fi
  fi
else
  echo "  ufw no está instalado: abra a mano SSH, 5060 UDP/TCP y 10000-20000 UDP"
  echo "  (con dominio, también 80/443, 7881/tcp y 50000-50100/udp) y mantenga cerrados el puerto de Redis, 7880 y 8088."
fi
echo "  Si su proveedor tiene firewall en el panel (Hetzner, AWS, DigitalOcean...), abra ahí los mismos puertos."

# ---------- 6. Contenedores ----------
say "Imagen y servicios"
docker compose build
docker compose up -d redis livekit sip
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:7880 >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:7880 >/dev/null 2>&1 || fail "LiveKit no respondió en 127.0.0.1:7880 (docker compose logs livekit)."

say "Troncal SIP de Zadarma en LiveKit"
if [ "$with_zadarma" = 1 ]; then
  docker compose run --rm --no-deps dispatcher python -m voice_confirm.trunk
else
  echo "  Omitida (modo simulación)."
fi

profiles=()
if [ -n "${DISPATCHER_DOMAIN:-}" ]; then
  # Si otro proxy (Nginx, Traefik, Coolify...) ya ocupa 80/443, Caddy no podría arrancar.
  busy="$(ss -H -tlnp 2>/dev/null | awk '$4 ~ /:(80|443)$/' | grep -v '"caddy"' || true)"
  if [ -n "$busy" ]; then
    echo "  ATENCIÓN: 80/443 ya están ocupados por otro servicio; no levanto Caddy."
    echo "  En ese proxy, apunte ${DISPATCHER_DOMAIN} a ${DISPATCHER_HOST:-127.0.0.1}:${DISPATCHER_PORT:-8088} y la ruta /rtc a 127.0.0.1:7880 (WebSocket)."
  else
    profiles=(--profile tls)
  fi
fi
docker compose "${profiles[@]}" up -d

# ---------- 7. Verificación ----------
say "Verificación"
sleep 5
check_status=0
./scripts/check.sh || check_status=$?

echo
ip="$(curl -fsS https://api.ipify.org 2>/dev/null || true)"
if [ -n "${DISPATCHER_DOMAIN:-}" ]; then
  echo "Simulador (habla con el agente desde el navegador): https://${DISPATCHER_DOMAIN}/prueba"
  echo "Pide el DISPATCHER_TOKEN del .env. Para un enlace que ya lo lleve: ./scripts/sim-link.sh"
  if [ -n "$ip" ] && [ "${LIVEKIT_USE_EXTERNAL_IP:-false}" != "true" ] && ! hostname -I 2>/dev/null | tr ' ' '\n' | grep -qx "$ip"; then
    echo "AVISO: la IP pública ${ip} no está en las interfaces del VPS (está detrás de NAT)."
    echo "  Si el simulador conecta pero no se oye, ponga LIVEKIT_USE_EXTERNAL_IP=true y vuelva a correr este script."
  fi
else
  echo "Para el simulador del navegador hace falta HTTPS: ponga un dominio en DISPATCHER_DOMAIN."
  if [ -n "$ip" ]; then
    echo "Sin DNS propio sirve uno gratuito que ya apunta a este VPS: DISPATCHER_DOMAIN=${ip//./-}.sslip.io"
  fi
  echo "Luego vuelva a correr: sudo ./scripts/bootstrap.sh"
fi
exit "$check_status"
