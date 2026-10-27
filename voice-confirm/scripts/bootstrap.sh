#!/usr/bin/env bash
# Instala y levanta todo en el VPS. Idempotente: se puede correr las veces que haga falta.
#
#   sudo ./scripts/bootstrap.sh            instala/actualiza y levanta
#   sudo FORCE_UFW=1 ./scripts/bootstrap.sh   activa el firewall aunque haya otros servicios expuestos
#
# Qué hace:
#   1. Instala Docker si falta.
#   2. Genera las claves internas que sigan en REEMPLAZA_ dentro de .env.
#   3. Verifica que estén las credenciales externas (Zadarma, AssemblyAI, LLM, voz, n8n).
#   4. Genera la configuración de LiveKit y del servicio SIP.
#   5. Abre en el firewall solo lo necesario (SSH, SIP 5060, audio 10000-20000/udp).
#   6. Construye la imagen, levanta LiveKit, crea la troncal de Zadarma y levanta el agente.
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
required=(ZADARMA_SIP_USER ZADARMA_SIP_PASSWORD ZADARMA_CALLER_NUMBER ASSEMBLYAI_API_KEY N8N_RESULT_WEBHOOK_URL)
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
  value="${!key:-}"
  if [ -z "$value" ] || [[ "$value" == REEMPLAZA_* ]]; then
    missing+=("$key")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "Faltan estas variables en $(pwd)/.env (vea la guía en cada línea):"
  printf '  - %s\n' "${missing[@]}"
  exit 2
fi
[[ "$ZADARMA_CALLER_NUMBER" == +57* ]] || fail "ZADARMA_CALLER_NUMBER debe ir en formato +57..."
echo "  completas"

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
      echo "  ufw activado (SSH ${ssh_port}, SIP 5060, audio 10000-20000/udp)."
    fi
  fi
else
  echo "  ufw no está instalado: abra a mano SSH, 5060 UDP/TCP y 10000-20000 UDP, y mantenga cerrados 6379, 7880, 7881, 8088 y 50000-50100."
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
docker compose run --rm --no-deps dispatcher python -m voice_confirm.trunk

profiles=()
[ -n "${DISPATCHER_DOMAIN:-}" ] && profiles=(--profile tls)
docker compose "${profiles[@]}" up -d

# ---------- 7. Verificación ----------
say "Verificación"
sleep 5
./scripts/check.sh
