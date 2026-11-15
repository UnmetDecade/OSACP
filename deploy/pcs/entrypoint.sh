#!/usr/bin/env bash
# PCS entrypoint for the single-machine demo.
#
# First start generates the signing keys, migrates the database, issues a demo
# admin token for the web proxy, and then runs the server. Nothing is baked into
# the image; keys and the token live in volumes.
set -euo pipefail

: "${PCS_DATABASE_URL:?PCS_DATABASE_URL is required}"

KEYS_DIR="${PCS_KEYS_DIR:-/app/keys}"
ADMIN_TOKEN_FILE="${ADMIN_TOKEN_FILE:-/run/demo/admin-token}"
ADMIN_TOKEN_HOURS="${ADMIN_TOKEN_HOURS:-720}"

mkdir -p "$KEYS_DIR" "$(dirname "$ADMIN_TOKEN_FILE")"
chmod 700 "$KEYS_DIR"

if [[ ! -s "$KEYS_DIR/private.pem" || ! -s "$KEYS_DIR/command-private.pem" ]]; then
  echo "[pcs] generating the JWT and command signing keys in $KEYS_DIR"
  node scripts/keygen.mjs
fi

export PCS_JWT_PRIVATE_KEY_FILE="$KEYS_DIR/private.pem"
export PCS_JWT_PUBLIC_KEY_FILE="$KEYS_DIR/public.pem"
export PCS_COMMAND_PRIVATE_KEY_FILE="$KEYS_DIR/command-private.pem"
export PCS_COMMAND_PUBLIC_KEY_FILE="$KEYS_DIR/command-public.pem"

for i in $(seq 1 60); do
  if node --import tsx src/migrate.ts; then
    break
  fi
  if [[ "$i" == "60" ]]; then
    echo "[pcs] database migration failed within 120 seconds" >&2
    exit 1
  fi
  echo "[pcs] waiting for the database ($i/60)..."
  sleep 2
done

# Demo storyline: hosts, deployments and sideloads for the example project.
# The real scheduler instances still register over the normal heartbeat path.
if [[ "${DEMO_SEED:-0}" == "1" ]]; then
  node --import tsx scripts/demo-seed.ts
fi

# The browser never receives this token: the web container's nginx injects it
# for /api/pcs. Regenerating it is safe because older tokens stay valid until
# they expire.
node --import tsx src/pcs.ts admin-token --operator demo --hours "$ADMIN_TOKEN_HOURS" --out "$ADMIN_TOKEN_FILE"
chmod 600 "$ADMIN_TOKEN_FILE"

exec node --import tsx src/main.ts
