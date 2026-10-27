# Imagen única para el agente de voz y el dispatcher (cambia solo el comando).
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

COPY voice_confirm ./voice_confirm

RUN useradd --create-home --uid 10001 genix \
    && mkdir -p /data \
    && chown genix:genix /data
USER genix

CMD ["python", "-m", "voice_confirm.agent", "start"]
