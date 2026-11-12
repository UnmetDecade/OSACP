#!/usr/bin/env bash
# 内部 CA 与测试证书生成（P6）。
#
# 用法：
#   ./scripts/pki.sh OUTDIR [额外 DNS 名...]
#
# 生成：
#   ca.key / ca.crt                 内部 CA（私钥 0600，生产应放离线/受控环境）
#   pcs.key / pcs.crt               PCS 服务端证书（serverAuth）
#   scheduler.key / scheduler.crt   调度机服务端证书（serverAuth）
#   secret-store.key / .crt         Secret Store 服务端证书（serverAuth）
#   client.key / client.crt         主机/实例客户端证书（clientAuth，测试共用）
#
# SAN 默认包含 localhost / 127.0.0.1 与传入的额外域名。
# 这是参考实现的测试脚本；生产证书应由企业 CA 或受控内部 CA 签发。
set -euo pipefail

OUT="${1:?用法: pki.sh OUTDIR [额外 DNS 名...]}"
shift || true
mkdir -p "$OUT"
chmod 700 "$OUT"

openssl version >/dev/null 2>&1 || { echo "需要 openssl" >&2; exit 1; }

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
    echo "CA 已存在，复用 $OUT/ca.crt"
    return
  fi
  openssl req -x509 -newkey rsa:3072 -nodes -sha256 -days 3650 \
    -subj "/CN=platform-internal-ca" \
    -keyout "$OUT/ca.key" -out "$OUT/ca.crt" >/dev/null 2>&1
  chmod 600 "$OUT/ca.key"
  echo "生成 CA $OUT/ca.crt"
}

gen_server() {
  local name="$1"
  if [[ -f "$OUT/$name.key" && -f "$OUT/$name.crt" ]]; then
    echo "服务端证书已存在，复用 $OUT/$name.crt"
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
  echo "生成服务端证书 $OUT/$name.crt"
}

gen_client() {
  if [[ -f "$OUT/client.key" && -f "$OUT/client.crt" ]]; then
    echo "客户端证书已存在，复用 $OUT/client.crt"
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
  echo "生成客户端证书 $OUT/client.crt"
}

gen_ca
gen_server pcs
gen_server scheduler
gen_server secret-store
gen_client
rm -f "$OUT/.ext-serverAuth.cnf" "$OUT/.ext-clientAuth.cnf"
echo "完成。服务端 SAN：$SAN"
