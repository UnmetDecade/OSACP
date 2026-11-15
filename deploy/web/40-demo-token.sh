#!/bin/sh
# nginx entrypoint hook for the demo image.
#
# Waits for PCS to write the admin token, then renders the proxy template with
# that token baked into the Authorization fallback. Runs before nginx starts.
set -eu

TOKEN_FILE="${ADMIN_TOKEN_FILE:-/run/demo/admin-token}"
TEMPLATE="${NGINX_TEMPLATE:-/etc/nginx/demo/default.conf.template}"

i=0
while [ ! -s "$TOKEN_FILE" ]; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then
    echo "[web] admin token not found at $TOKEN_FILE after 120s" >&2
    exit 1
  fi
  sleep 1
done

PCS_ADMIN_TOKEN="$(cat "$TOKEN_FILE")"
export PCS_ADMIN_TOKEN

# Only substitute the token: nginx variables such as $host must stay untouched.
envsubst '${PCS_ADMIN_TOKEN}' < "$TEMPLATE" > /etc/nginx/conf.d/default.conf
echo "[web] proxy config written; the demo admin token is injected for /api/pcs"
