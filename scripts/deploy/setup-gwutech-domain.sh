#!/usr/bin/env bash
set -euo pipefail

DOMAIN="app.gwutech.com"
SITE_NAME="wmspro"
NGINX_CONF_SOURCE="deploy/nginx/wmspro.gwutech.conf"
NGINX_CONF_TARGET="/etc/nginx/sites-available/${SITE_NAME}"
NGINX_ENABLED_TARGET="/etc/nginx/sites-enabled/${SITE_NAME}"

if [[ "${EUID}" -eq 0 ]]; then
  echo "Run this script as a sudo-capable user, not as root."
  exit 1
fi

if [[ ! -f "${NGINX_CONF_SOURCE}" ]]; then
  echo "Missing ${NGINX_CONF_SOURCE}. Run from repo root."
  exit 1
fi

echo "[1/6] Checking DNS for ${DOMAIN}..."
if ! getent ahosts "${DOMAIN}" >/dev/null 2>&1; then
  echo "DNS is not ready for ${DOMAIN}."
  echo "Create DNS record first: A app -> 157.245.106.194"
  exit 1
fi

echo "[2/6] Installing nginx site config..."
sudo cp "${NGINX_CONF_SOURCE}" "${NGINX_CONF_TARGET}"
sudo ln -sfn "${NGINX_CONF_TARGET}" "${NGINX_ENABLED_TARGET}"

echo "[3/6] Validating nginx config..."
sudo nginx -t

echo "[4/6] Reloading nginx..."
sudo systemctl reload nginx

echo "[5/6] Ensuring certbot is installed..."
sudo apt-get update -y
sudo apt-get install -y certbot python3-certbot-nginx

echo "[6/6] Issuing/renewing TLS certificate for ${DOMAIN}..."
sudo certbot --nginx -d "${DOMAIN}" --non-interactive --agree-tos -m "info@gwutech.com" --redirect

echo "Done. Quick checks:"
echo "  curl -I https://${DOMAIN}"
echo "  curl -fsS https://${DOMAIN}/api/health"
