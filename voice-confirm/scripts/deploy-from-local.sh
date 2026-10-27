#!/usr/bin/env bash
# Desde su computador (o desde el agente voice-vps-ops): copia voice-confirm/ al VPS y corre bootstrap.sh.
#
#   VPS_HOST=203.0.113.10 ./voice-confirm/scripts/deploy-from-local.sh
#
# Variables: VPS_HOST (obligatoria), VPS_USER (root), VPS_PORT (22), VPS_DIR (/opt/genix-voice),
#            SSH_KEY (opcional, ruta a la llave privada).
# Si existe voice-confirm/.env en su computador, se copia al VPS (permisos 600). Si no, se usa el del VPS.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"

: "${VPS_HOST:?Defina VPS_HOST con la IP o dominio del VPS}"
VPS_USER="${VPS_USER:-root}"
VPS_PORT="${VPS_PORT:-22}"
VPS_DIR="${VPS_DIR:-/opt/genix-voice}"

ssh_opts=(-p "$VPS_PORT" -o BatchMode=yes -o ConnectTimeout=15)
[ -n "${SSH_KEY:-}" ] && ssh_opts+=(-i "$SSH_KEY")
target="${VPS_USER}@${VPS_HOST}"
sudo_cmd=""
[ "$VPS_USER" != "root" ] && sudo_cmd="sudo"

echo "== Probando acceso SSH a ${target}:${VPS_PORT}"
ssh "${ssh_opts[@]}" "$target" "echo conectado: \$(hostname) \$(. /etc/os-release && echo \$PRETTY_NAME)"

echo "== Copiando archivos a ${VPS_DIR}"
ssh "${ssh_opts[@]}" "$target" "${sudo_cmd} mkdir -p '${VPS_DIR}' && ${sudo_cmd} chown \$(id -u):\$(id -g) '${VPS_DIR}'"
rsync -az --delete \
  --exclude '.env' --exclude 'data/' --exclude 'generated/' --exclude '__pycache__/' --exclude '.pytest_cache/' \
  -e "ssh ${ssh_opts[*]}" "${here}/" "${target}:${VPS_DIR}/"

if [ -f "${here}/.env" ]; then
  echo "== Copiando .env local (permisos 600)"
  rsync -az --chmod=F600 -e "ssh ${ssh_opts[*]}" "${here}/.env" "${target}:${VPS_DIR}/.env"
fi

echo "== Instalando y levantando en el VPS"
ssh -t "${ssh_opts[@]}" "$target" "cd '${VPS_DIR}' && chmod +x scripts/*.sh && ${sudo_cmd} ./scripts/bootstrap.sh"
