# Deploying Switchyard

Targets a single shared VPS behind an existing nginx, not a managed platform. Everything
binds to `127.0.0.1`; nginx is the only public entrance.

## Why not serverless

`GET /v1/stream` holds a Server-Sent Events connection open for hours. Serverless function
platforms cap a request at seconds to minutes, so the dashboard and every SDK would
reconnect constantly and propagation would stop being sub-second. The API needs a real
long-lived process.

## Ports

Chosen around what the host already runs. `4000` in particular is taken by another
application, so the API publishes on `4100` while still listening on `4000` inside its
container.

| Service | Container | Host | Public |
| --- | --- | --- | --- |
| postgres | 5432 | 127.0.0.1:5435 | no |
| api | 4000 | 127.0.0.1:4100 | via `/api/` |
| web | 3000 | 127.0.0.1:3100 | via `/` |

The host's PostgreSQL instances on 5432, 5433 and 5434 belong to other applications and
are never touched. This stack runs its own.

## Memory

The host has under 2 GB and already runs other production sites, so every service declares
a limit. An unbounded container here would take its neighbours down with it.

| Service | Limit |
| --- | --- |
| postgres | 192M |
| api | 256M |
| web | 256M |

## First deploy

```bash
# 1. DNS: an A record for switchyard -> this host must resolve before certbot runs.
dig +short switchyard.nexorahq.my.id

# 2. Code and secrets
git clone https://github.com/Fanani23/switchyard /opt/switchyard
cd /opt/switchyard/deploy
cp .env.example .env
openssl rand -hex 32            # paste into SWITCHYARD_ROOT_KEY
openssl rand -hex 24            # paste into POSTGRES_PASSWORD and DATABASE_URL
chmod 600 .env

# 3. Build and start. migrate runs once and must exit 0 before api starts.
docker compose -f docker-compose.prod.yml up -d --build

# 4. Certificate, then the site
certbot certonly --nginx -d switchyard.nexorahq.my.id
cp nginx/switchyard.conf /etc/nginx/sites-available/switchyard.conf
ln -sf /etc/nginx/sites-available/switchyard.conf /etc/nginx/sites-enabled/switchyard.conf
nginx -t && systemctl reload nginx
```

`nginx -t` before every reload. A broken config would take down the other five sites on
this host, not only this one.

## Updating

```bash
cd /opt/switchyard && git pull
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
```

Migrations are forward-only and run automatically. See `apps/api/drizzle/ROLLBACK.md`
before reversing one.

## Rollback

```bash
cd /opt/switchyard && git checkout <previous-sha>
cd deploy && docker compose -f docker-compose.prod.yml up -d --build
```

This reverts code only. A migration applied by the newer version stays applied; reverse it
with a forward migration as `ROLLBACK.md` describes.

## Secrets

`.env` lives on the server at mode 600 and is gitignored. `SWITCHYARD_ROOT_KEY` is the only
thing standing between the public internet and full control of every flag, so treat it as a
password: rotate it by editing `.env` and running `docker compose up -d api`.
