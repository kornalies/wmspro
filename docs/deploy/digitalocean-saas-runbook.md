# WMS Pro SaaS Deployment Runbook (DigitalOcean Droplet)

Last updated: 2026-03-23

This runbook deploys WMS Pro on an Ubuntu Droplet with:
- `systemd` for process supervision
- `nginx` reverse proxy
- Let's Encrypt TLS
- PostgreSQL over TLS (recommended for SaaS)

## 1) Target Architecture

- App server: Next.js (`next start`) on `127.0.0.1:3000`
- Reverse proxy: `nginx` on `80/443`
- Database: DigitalOcean Managed PostgreSQL (private network, TLS enabled)
- Service account: `wms`
- App path: `/opt/wmspro/current`

## 2) Prerequisites

- Ubuntu 22.04 or 24.04 Droplet
- Domain DNS A record pointing to Droplet IP (example: `app.wmspro.com`)
- Managed PostgreSQL connection string ready
- SSH access with sudo user

## 3) One-Time Server Bootstrap

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx git curl ufw
```

Create app user:

```bash
sudo adduser --disabled-password --gecos "" wms
sudo usermod -aG sudo wms
```

Install Node.js 20 LTS (NodeSource):

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v
npm -v
```

Firewall:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

## 4) App Setup

```bash
sudo mkdir -p /opt/wmspro
sudo chown -R wms:wms /opt/wmspro
sudo -u wms git clone <YOUR_REPO_URL> /opt/wmspro/current
cd /opt/wmspro/current
npm ci
```

Create env file:

```bash
cp .env.example .env.production
```

Set production env values in `.env.production`:

- `NODE_ENV=production`
- `NEXT_PUBLIC_APP_NAME=WMS Pro`
- `JWT_SECRET=<strong-random-secret>`
- `DATABASE_URL=<managed-postgres-app-user-url>`
- `MIGRATOR_DATABASE_URL=<managed-postgres-migrator-user-url>`
- `DB_SSL=true`
- `PGSSLMODE=require`
- `DB_SSL_REJECT_UNAUTHORIZED=true` (preferred when CA trust is configured)

If cert trust is not configured yet, temporarily use:
- `DB_SSL_REJECT_UNAUTHORIZED=false`

## 5) DB Migration

Run once per release:

```bash
cd /opt/wmspro/current
set -a; source .env.production; set +a
npm run db:migrate
```

Do **not** run `db:seed` in production unless explicitly intended.

## 6) Build and Start

Important: use standard production build.

```bash
cd /opt/wmspro/current
set -a; source .env.production; set +a
npx next build
```

Install service:

```bash
sudo cp deploy/systemd/wmspro.service /etc/systemd/system/wmspro.service
sudo systemctl daemon-reload
sudo systemctl enable wmspro
sudo systemctl start wmspro
sudo systemctl status wmspro --no-pager
```

## 7) Nginx and TLS

Install nginx site:

```bash
sudo cp deploy/nginx/wmspro.conf /etc/nginx/sites-available/wmspro
sudo ln -s /etc/nginx/sites-available/wmspro /etc/nginx/sites-enabled/wmspro
sudo nginx -t
sudo systemctl reload nginx
```

Issue TLS cert:

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d app.wmspro.com
```

## 8) Post-Deploy Validation

```bash
curl -fsS https://app.wmspro.com/api/health
```

Expected response contains:
- `"status":"ok"`
- `"checks":{"db":"ok","tenant_context":"ok"}`

Also validate login and one core workflow (GRN/DO/Billing API).

## 9) Release Procedure (Each Deployment)

```bash
cd /opt/wmspro/current
git fetch --all
git checkout <release-tag-or-commit>
npm ci
set -a; source .env.production; set +a
npm run db:migrate
npx next build
sudo systemctl restart wmspro
curl -fsS http://127.0.0.1:3000/api/health
```

## 10) Rollback Procedure

```bash
cd /opt/wmspro/current
git checkout <previous-known-good-tag>
npm ci
set -a; source .env.production; set +a
npx next build
sudo systemctl restart wmspro
```

If a migration is not backward-compatible, follow DB rollback plan before app rollback.

## 11) Operational Guardrails

- Keep Postgres private-network only (no public DB ingress).
- Enforce least-privileged DB roles (`wms_app`, `wms_migrator`).
- Rotate `JWT_SECRET` and DB credentials before SaaS onboarding.
- Keep nightly DB backups and test restore monthly.
- Monitor:
  - `systemctl status wmspro`
  - `journalctl -u wmspro -f`
  - nginx access/error logs

