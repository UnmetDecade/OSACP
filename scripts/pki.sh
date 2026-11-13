#!/usr/bin/env bash
# Internal CA and test certificate generation (P6).
#
# Usage:
#   ./scripts/pki.sh OUTDIR [extra DNS names...]
#
# Generates:
#   ca.key / ca.crt                 Internal CA (private key 0600; in production should be kept offline/controlled)
#   pcs.key / pcs.crt               PCS server certificate (serverAuth)
#   scheduler.key / scheduler.crt   Scheduler server certificate (serverAuth)
#   secret-store.key / .crt         Secret Store server certificate (serverAuth)
#   client.key / client.crt         Host/instance client certificate (clientAuth, shared for testing)
#
# SAN by default includes localhost / 127.0.0.1 and any extra domain names passed in.
# This is a test script for the reference implementation; production certificates should be issued by an enterprise CA or a controlled internal CA.
set -euo pipefail

OUT="${1:?Usage: pki.sh OUTDIR [extra DNS names...]}"
shift || true
mkdir -p "$OUT"
chmod 700 "$OUT"

openssl version >/dev/null 2>&1 || { echo "openssl is required" >&2; exit 1; }

SAN="DNS:localhost,IP:127.0.0.1"
for name in "$@"; do
  [[ -n "$name" ]] && SAN="$SAN,DNS:$name"
done

ext_file() {
  local usage="$1"
  local file="$OUT/.ext-$usage.cnf"
  cat > "$file" <<EOF
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = $usage
subjectAltName = $SAN
EOF
  echo "$file"
}

gen_ca() {
  if [[ -f "$OUT/ca.key" && -f "$OUT/ca.crt" ]]; then
    echo "CA exists, reusing $OUT/ca.crt"
    return
  fi
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/CN=platform-internal-ca" \
    -keyout "$OUT/ca.key" -out "$OUT/ca.crt" >/dev/null 2>&1
  chmod 600 "$OUT/ca.key"
  echo "Generating CA $OUT/ca.crt"
}

gen_server() {
  local name="$1"
  if [[ -f "$OUT/$name.key" && -f "$OUT/$name.crt" ]]; then
    echo "Server certificate exists, reusing $OUT/$name.crt"
    return
  fi
  local csr="$OUT/.$name.csr" ext
  ext="$(ext_file serverAuth)"
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=$name" -keyout "$OUT/$name.key" -out "$csr" >/dev/null 2>&1
  openssl x509 -req -in "$csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
    -CAcreateserial -days 825 -sha256 -extfile "$ext" -out "$OUT/$name.crt" >/dev/null 2>&1
  chmod 600 "$OUT/$name.key"
  rm -f "$csr"
  echo "Generating server certificate $OUT/$name.crt"
}

gen_client() {
  if [[ -f "$OUT/client.key" && -f "$OUT/client.crt" ]]; then
    echo "Client certificate exists, reusing $OUT/client.crt"
    return
  fi
  local csr="$OUT/.client.csr" ext
  ext="$(ext_file clientAuth)"
  openssl req -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=platform-host-client" -keyout "$OUT/client.key" -out "$csr" >/dev/null 2>&1
  openssl x509 -req -in "$csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" \
    -CAcreateserial -days 825 -sha256 -extfile "$ext" -out "$OUT/client.crt" >/dev/null 2>&1
  chmod 600 "$OUT/client.key"
  rm -f "$csr"
  echo "Generating client certificate $OUT/client.crt"
}

gen_ca
gen_server pcs
gen_server scheduler
gen_server secret-store
gen_client
rm -f "$OUT/.ext-serverAuth.cnf" "$OUT/.ext-clientAuth.cnf"
echo "Done. Server SAN: $SAN"
