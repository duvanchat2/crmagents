# Despliegue — crm.colgorent.com

## Servidor
- VPS Contabo `vmi3434903` (169.58.3.158), Ubuntu, Docker.
- Comparte servidor con Supabase, Hermes y los sitios de GoRent. **Instalación aislada**: no toca nada de eso.

## Aislamiento
- Carpeta: `/opt/vocero/app`
- Proyecto Docker: `-p vocero` (contenedores, red y volúmenes con prefijo `vocero_`)
- Postgres propio e interno (sin puertos publicados; no choca con Supabase 5432/6543)
- App publicada solo en `127.0.0.1:3100`
- El Caddy de Vocero está desactivado (`docker-compose.override.yml`); los puertos 80/443 son de Nginx

## Nginx + HTTPS
- Sitio: `/etc/nginx/sites-available/crm-colgorent.conf` (enlace en `sites-enabled`)
- `proxy_pass http://127.0.0.1:3100`, `proxy_buffering off` (SSE)
- Certificado Let's Encrypt con `certbot --nginx -d crm.colgorent.com --redirect` (renovación automática)
- Aplicar cambios siempre con `nginx -t` y luego `systemctl reload nginx` (nunca restart)

## Secretos
- En `/opt/vocero/app/.env` (chmod 600), **nunca en el repo**
- Variables: APP_BASE_URL, DOMAIN, POSTGRES_PASSWORD, DATABASE_URL, BETTER_AUTH_SECRET, ENCRYPTION_KEY, META_WEBHOOK_VERIFY_TOKEN, META_GRAPH_API_VERSION

## Cuenta
- Una sola cuenta owner, creada desde el VPS vía `POST /api/auth/sign-up/email`
- El registro público queda cerrado al existir la organización

## Desplegar una nueva versión (manual)
```bash
cd /opt/vocero/app
git pull
docker compose -p vocero up -d --build app postgres
curl -s http://127.0.0.1:3100/api/health
```

## Deshacer por completo
```bash
cd /opt/vocero/app && docker compose -p vocero down -v
rm -rf /opt/vocero
rm /etc/nginx/sites-enabled/crm-colgorent.conf && nginx -t && systemctl reload nginx
```
