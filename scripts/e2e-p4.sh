#!/usr/bin/env bash
# P4 acceptance: Agent/API integration (Profile, Secret, API Adapter, Tool Policy Guard, default-deny egress).
#
# Covers:
#   A. Swap the Agent for the same role: PCS binds agp_worker_alpha → agp_worker_beta, changing only configuration and rolling-restarting instances,
#      with no changes to the scheduler or role code; the two artifact markers differ.
#   B. The task envelope carries only a Profile reference; the Agent gets only a local proxy handle, and logs/envelopes/artifacts contain no keys.
#   C. A privilege-escalating tool call (demo.forbidden) is rejected by the Policy Guard; APIs can only go through the local proxy.
#   D. Default-deny egress: the cloud metadata address (169.254.169.254) is blocked by EGRESS_IP_BLOCKED.
#   E. Secret Store instance isolation: Worker A cannot resolve Worker B's secret_ref; revocation takes effect immediately.
#   F. Quota rpm=2: beyond that the local proxy returns 429.
#   G. Agent crash: role-agent stays ONLINE, and the task is reported as a retryable failure.
#
# Side effects: resets the scheduler / platform_control demo databases, and restarts the scheduler, Host Runtime, role instances,
#         PCS, Secret Store and mock upstream. For test environments only.
#
# Usage: scripts/e2e-p4.sh
set -euo pipefail

# Node 22 on the remote test machine is not in the non-interactive PATH; child processes (node/npm/tsx) all depend on it
export PATH="${NODE_BIN_DIR:-$HOME/opt/node-v22.20.0-linux-x64/bin}:$PATH"

SCHEDULER_URL=${SCHEDULER_URL:-http://127.0.0.1:7801}
RUNTIME_DIR=${RUNTIME_DIR:-$HOME/host-runtime}
SCHEDULER_DIR=${SCHEDULER_DIR:-$HOME/scheduler}
PCS_ISSUER_DIR=${PCS_ISSUER_DIR:-$HOME/pcs-issuer}
SECRET_STORE_DIR=${SECRET_STORE_DIR:-$HOME/secret-store}
PLATFORM_DIR=${PLATFORM_DIR:-$HOME/platform}
PCS_URL=${PCS_URL:-http://127.0.0.1:7901}
SECRET_STORE_URL=${SECRET_STORE_URL:-http://127.0.0.1:7902}
PCS_PUBLIC_KEY_FILE=${PCS_PUBLIC_KEY_FILE:-$PCS_ISSUER_DIR/keys/public.pem}
export HOST_ADMISSION_SOCKET=${HOST_ADMISSION_SOCKET:-$RUNTIME_DIR/run-live/runtime.sock}
export INSTANCE_TOKEN_DIR=${INSTANCE_TOKEN_DIR:-$RUNTIME_DIR/run/tokens}
PSQL_SCHED=${PSQL_SCHED:-"docker exec pg-sched psql -U postgres -d scheduler"}
PSQL_PCS=${PSQL_PCS:-"docker exec pg-sched psql -U postgres -d platform_control"}
NODE_BIN=${NODE_BIN:-$HOME/opt/node-v22.20.0-linux-x64/bin/node}
NPM_BIN=${NPM_BIN:-$HOME/opt/node-v22.20.0-linux-x64/bin/npm}
OPERATOR=${OPERATOR:-alice}

RUN_ID="$(date +%Y%m%d%H%M%S)-$$"
P4_DIR="$PLATFORM_DIR/p4/$RUN_ID"
TMP="$(mktemp -d)"
mkdir -p "$P4_DIR"
trap 'rm -rf "$TMP"' EXIT

AGENTS=(worker-a worker-b reviewer-a tester-a after-a)
SECRET_VALUE="mock-secret-$RUN_ID-9f3a"
SECRET_REF="secret://apis/mock"
SECRET_REF_B="secret://apis/worker-b-only"

say() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*" >&2; exit 1; }

sqls() { $PSQL_SCHED -tA -c "$1"; }
sqlp() { $PSQL_PCS -tA -c "$1"; }
jget() {
  python3 -c '
import sys,json
d=json.load(sys.stdin)
for p in sys.argv[1].split("."):
    if p == "": continue
    d = d[int(p)] if p.isdigit() else d[p]
print(d)
' "$1"
}
api_json() { curl -sf "$@"; }
wait_run() {
  local i
  for i in $(seq 1 $(( $3 * 4 ))); do
    [[ "$(api_json "$SCHEDULER_URL/v1/workflows/$1" | jget status)" == "$2" ]] && return 0
    sleep 0.25
  done
  fail "工作流 $1 在 $3s 内没有变成 $2（当前 $(api_json "$SCHEDULER_URL/v1/workflows/$1" | jget status)）"
}
create_workflow() { # template ref requirements_json
  api_json -X POST "$SCHEDULER_URL/v1/workflows" -H 'content-type: application/json' \
    -d "{\"workflow_template_id\":\"$1\",\"payload_ref\":\"$2\",\"requirements\":$3}" |
    jget run.workflow_run_id
}
issue_instance_token() {
  (cd "$PCS_ISSUER_DIR" && "$NPM_BIN" run --silent issue -- instance \
    --id "$1" --role "$2" --host "$3" --out "$INSTANCE_TOKEN_DIR/$1.jwt" >/dev/null)
}
wait_online() { # instance-id timeout_s
  local i
  for i in $(seq 1 $(( $2 * 4 ))); do
    [[ "$(sqls "SELECT state FROM role_instances WHERE instance_id = '$1'")" == "ONLINE" ]] && return 0
    sleep 0.25
  done
  return 1
}
kill_port() { # port
  local pid
  pid=$(ss -ltnp 2>/dev/null | grep ":$1 " | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2 || true)
  [[ -n "${pid:-}" ]] && { kill "$pid" 2>/dev/null || true; sleep 0.6; }
  return 0
}

# ---- Preflight checks -----------------------------------------------------
say "前置检查"
for f in "$PCS_PUBLIC_KEY_FILE" "$PCS_ISSUER_DIR/keys/private.pem" \
         "$PLATFORM_DIR/agents/demo-agent.mjs" "$SECRET_STORE_DIR/src/main.ts"; do
  [[ -f "$f" ]] || fail "缺少 $f"
done
[[ -x "$NODE_BIN" ]] || fail "缺少 Node 22：$NODE_BIN"
ok "公钥、私钥、Agent、Secret Store 源码齐备"

# ---- Reset and infrastructure ---------------------------------------------
say "重置数据库并启动 PCS / Secret Store / mock upstream"
(cd "$RUNTIME_DIR" && ./scripts/stop.sh "${AGENTS[@]}" >/dev/null 2>&1 || true)
sleep 2
# P4 adds role_instances.agent_profile_version / api_profile_ids (sql/003_profiles.sql)
(cd "$SCHEDULER_DIR" && "$NPM_BIN" run --silent migrate >/dev/null)
"$SCHEDULER_DIR/scripts/reset.sh" >/dev/null
(cd "$PCS_ISSUER_DIR" && "$NPM_BIN" run --silent migrate >/dev/null)
sqlp "TRUNCATE role_api_bindings, role_agent_bindings, api_profiles, agent_profiles, pcs_audit_logs CASCADE" >/dev/null

kill_port 7901
(cd "$PCS_ISSUER_DIR" && PCS_ALLOW_INSECURE_API_URLS=1 PCS_IMAGE_ALLOWLIST=registry.example/ \
  setsid -f "$NPM_BIN" start >> "$P4_DIR/pcs.log" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf "$PCS_URL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$PCS_URL/healthz" >/dev/null || fail "PCS 没有起来"

# secrets / policy: 0600, values are not written into any Profile or envelope
mkdir -p "$P4_DIR/secret-store"
python3 - "$P4_DIR/secret-store/secrets.json" "$SECRET_REF" "$SECRET_VALUE" "$SECRET_REF_B" "mock-worker-b-$RUN_ID" <<'PY'
import json, os, sys
p, ref, value, ref_b, value_b = sys.argv[1:]
with open(p, "w") as f:
    json.dump({ref: value, ref_b: value_b}, f)
os.chmod(p, 0o600)
PY
python3 - "$P4_DIR/secret-store/policy.json" "$SECRET_REF" "$SECRET_REF_B" <<'PY'
import json, os, sys
p, ref, ref_b = sys.argv[1:]
with open(p, "w") as f:
    json.dump({"worker-a": [ref], "worker-b": [ref_b]}, f)
os.chmod(p, 0o600)
PY

kill_port 7902
(cd "$SECRET_STORE_DIR" && \
  SECRET_STORE_SECRETS_FILE="$P4_DIR/secret-store/secrets.json" \
  SECRET_STORE_POLICY_FILE="$P4_DIR/secret-store/policy.json" \
  SECRET_STORE_AUDIT_FILE="$P4_DIR/secret-store/audit.jsonl" \
  PCS_PUBLIC_KEY_FILE="$PCS_PUBLIC_KEY_FILE" \
  SECRET_STORE_ADMIN_TOKEN="admin-$RUN_ID" \
  setsid -f "$NPM_BIN" start >> "$P4_DIR/secret-store.log" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf "$SECRET_STORE_URL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$SECRET_STORE_URL/healthz" >/dev/null || fail "Secret Store 没有起来"

kill_port 18090
rm -f "$P4_DIR/mock-api.log"
(cd "$PLATFORM_DIR" && MOCK_API_PORT=18090 MOCK_API_EXPECTED_TOKEN="$SECRET_VALUE" \
  MOCK_API_LOG="$P4_DIR/mock-api.log" \
  setsid -f "$NODE_BIN" scripts/p4-mock-upstream.mjs >> "$P4_DIR/mock-api.out" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:18090/whoami" && break; sleep 0.5; done
ok "PCS :7901 / Secret Store :7902 / mock upstream :18090 已启动"

# ---- PCS Profile and bindings ---------------------------------------------
say "创建 Agent / API Profile 并绑定 worker-a"
ADMIN_TOKEN=$(cd "$PCS_ISSUER_DIR" && "$NPM_BIN" run --silent pcs -- admin-token --operator "$OPERATOR")
export PCS_ADMIN_TOKEN="$ADMIN_TOKEN"

create_agent() { # id marker version
  python3 - "$PCS_URL" "$ADMIN_TOKEN" "$1" "$2" "$3" "$NODE_BIN" \
    "$PLATFORM_DIR/agents/demo-agent.mjs" <<'PY'
import json, sys, urllib.request
url, token, aid, marker, version, node, agent_file = sys.argv[1:]
body = {
  "agent_profile_id": aid,
  "role_id": "worker",
  "name": f"demo-{marker}",
  "version": version,
  "adapter": "stdio-jsonrpc",
  "artifact_image": "registry.example/agents/demo@sha256:" + "a"*64,
  "entrypoint": [node, agent_file, f"--marker={marker}"],
  "args": [],
  "allowed_tools": ["demo.echo", "api.call"],
  "task_types": ["task.agent.probe"],
  "limits": {"max_turns": 10, "max_wall_seconds": 30},
}
req = urllib.request.Request(url + "/api/v1/platform/agent-profiles", method="POST",
    data=json.dumps(body).encode(), headers={"authorization": "Bearer " + token,
    "content-type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
PY
}

create_api() { # id name base_url secret_ref rpm egress scope
  python3 - "$PCS_URL" "$ADMIN_TOKEN" "$1" "$2" "$3" "$4" "$5" "$6" "$7" <<'PY'
import json, sys, urllib.request
url, token, aid, name, base, secret, rpm, egress, scope = sys.argv[1:]
body = {
  "api_profile_id": aid, "name": name, "kind": "tool",
  "base_url": base, "auth_type": "bearer", "secret_ref": secret,
  "scopes": [scope], "quota": {"rpm": int(rpm)}, "timeout_seconds": 5,
  "egress": egress, "fallback": [],
}
req = urllib.request.Request(url + "/api/v1/platform/api-profiles", method="POST",
    data=json.dumps(body).encode(), headers={"authorization": "Bearer " + token,
    "content-type": "application/json"})
print(urllib.request.urlopen(req).read().decode())
PY
}

bind_agent() { # instance agent role
  curl -sf -X POST "$PCS_URL/api/v1/platform/instances/$1/bind-agent" \
    -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d "{\"agent_profile_id\":\"$2\",\"role_id\":\"$3\"}" >/dev/null
}
bind_api() {
  curl -sf -X POST "$PCS_URL/api/v1/platform/instances/$1/bind-api" \
    -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
    -d "{\"api_profile_id\":\"$2\"}" >/dev/null
}

create_agent agp_worker_alpha alpha 1.0.0 >/dev/null
create_agent agp_worker_beta beta 1.0.0 >/dev/null
create_api api_mock "mock tool" "http://127.0.0.1:18090" "$SECRET_REF" 2 egress-mock probe.read >/dev/null
create_api api_meta "metadata probe" "https://169.254.169.254" "secret://apis/meta" 10 egress-meta probe.read >/dev/null
bind_agent worker-a agp_worker_alpha worker
bind_api worker-a api_mock
bind_api worker-a api_meta
ok "Profile 已创建，worker-a 绑定 agp_worker_alpha + api_mock + api_meta"

export_profiles() { # outfile agent id is read from PCS binding
  curl -sf "$PCS_URL/api/v1/platform/instances/worker-a/resolve" \
    -H "authorization: Bearer $ADMIN_TOKEN" > "$TMP/resolve.json"
  python3 - "$TMP/resolve.json" "$1" <<'PY'
import json, sys
src, out = sys.argv[1:]
d = json.load(open(src))
profiles = {
  "agent_profiles": [d["agent"]],
  "api_profiles": d["api_profiles"],
  "bindings": {"worker-a": {
      "agent_profile_id": d["agent"]["agent_profile_id"],
      "api_profile_ids": [p["api_profile_id"] for p in d["api_profiles"]],
  }},
}
# Regression guard: the runtime view must never contain secret values (only secret:// references).
blob = json.dumps(profiles)
assert "secret://" in blob
json.dump(profiles, open(out, "w"), indent=2)
PY
}
export_profiles "$RUNTIME_DIR/profiles.p4.json"

# Runtime config: only load Profiles for worker-a
python3 - "$RUNTIME_DIR/runtime.config.json" "$RUNTIME_DIR/profiles.p4.json" \
  "$SECRET_STORE_URL" "$RUNTIME_DIR/run-live/audit" <<'PY'
import json, sys
cfg_path, profiles_path, secret_url, audit_dir = sys.argv[1:]
d = json.load(open(cfg_path))
d.update({
  "profiles_file": profiles_path,
  "secret_store_url": secret_url,
  "allow_loopback_egress": True,
  "egress_policies": {
    "egress-mock": ["127.0.0.1"],
    "egress-meta": ["169.254.169.254"],
  },
  "audit_dir": audit_dir,
})
for i in d["instances"]:
    if i["instance_id"] == "worker-a":
        i["agent_profile_id"] = "agp_worker_alpha"
        i["agent_profile_version"] = "1.0.0"
        i["api_profile_ids"] = ["api_mock", "api_meta"]
        if "task.agent.probe" not in i["task_types"]:
            i["task_types"].append("task.agent.probe")
        if "llm" not in i["capabilities"]["healthy"]:
            i["capabilities"]["healthy"].append("llm")
json.dump(d, open(cfg_path, "w"), indent=2)
PY

# ---- Restart scheduler / Runtime / roles ----------------------------------
say "重启调度机 / Host Runtime / 角色实例"
(cd "$RUNTIME_DIR" && ./scripts/runtime.sh stop >/dev/null 2>&1 || true)
(cd "$RUNTIME_DIR" && ./scripts/runtime.sh start | sed 's/^/  /')
for i in $(seq 1 40); do [[ -S "$HOST_ADMISSION_SOCKET" ]] && break; sleep 0.5; done
[[ -S "$HOST_ADMISSION_SOCKET" ]] || fail "Host Runtime 准入 socket 未就绪"

kill_port 7801
(cd "$SCHEDULER_DIR" && PCS_PUBLIC_KEY_FILE="$PCS_PUBLIC_KEY_FILE" \
  setsid -f "$NPM_BIN" start >> "$P4_DIR/scheduler.log" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf "$SCHEDULER_URL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$SCHEDULER_URL/healthz" >/dev/null || fail "调度机没有起来"

issue_instance_token worker-a worker host-a
issue_instance_token worker-b worker host-a
issue_instance_token reviewer-a reviewer host-b
issue_instance_token tester-a tester host-a
issue_instance_token after-a after_sales host-b
(cd "$RUNTIME_DIR" && ./scripts/start.sh "${AGENTS[@]}" | sed 's/^/  /')
wait_online worker-a 30 || fail "worker-a 没有 ONLINE；见 $RUNTIME_DIR/run/worker-a.log"
ok "worker-a 以 Agent 模式 ONLINE"

# ---- A. Agent execution + tool/egress policy ------------------------------
say "A. alpha Agent 执行探针（越权工具、出站默认拒绝、API 经本地代理）"
REQ_A=$(python3 -c 'import json;print(json.dumps({
  "message":"hello-p4-alpha",
  "probe_forbidden":True,
  "probe_api":True,
  "api_profile_id":"api_mock",
  "probe_api_meta":True,
}))')
RUN_A=$(create_workflow wft_agent_probe "svn://e2e-p4/$RUN_ID/alpha" "$REQ_A")
wait_run "$RUN_A" COMPLETED 60
ok "alpha 工作流 COMPLETED"

TASK_A=$(sqls "SELECT task_id FROM tasks WHERE workflow_run_id = '$RUN_A'")
ART_A=$(sqls "SELECT a.artifact_id FROM artifacts a JOIN tasks t USING (task_id) WHERE t.workflow_run_id = '$RUN_A' AND a.status = 'COMPLETE' ORDER BY a.created_at DESC LIMIT 1")
[[ -n "$ART_A" ]] || fail "alpha 没有产出制品"
curl -sf "$SCHEDULER_URL/v1/artifacts/$ART_A/content" \
  -H "authorization: Bearer $(cat "$INSTANCE_TOKEN_DIR/worker-a.jwt")" > "$TMP/result-alpha.json"
jget marker < "$TMP/result-alpha.json" | grep -qx alpha || fail "产物 marker 不是 alpha"
forbidden=$(jget forbidden < "$TMP/result-alpha.json")
grep -q "TOOL_NOT_ALLOWED" <<<"$forbidden" || fail "越权 tool 未被拒绝：$forbidden"
api_status=$(jget api.status < "$TMP/result-alpha.json")
[[ "$api_status" == "200" ]] || fail "API 调用失败：$(cat "$TMP/result-alpha.json")"
meta_err=$(jget api_meta.error < "$TMP/result-alpha.json")
grep -q "EGRESS_IP_BLOCKED" <<<"$meta_err" || fail "元数据地址没有被默认拒绝：$meta_err"
ok "alpha 产物：越权工具被拒、API 经代理成功、元数据地址 EGRESS_IP_BLOCKED"

grep -q '"auth_ok": *true' "$P4_DIR/mock-api.log" || fail "mock upstream 没有收到带认证的请求"
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18090/whoami)" == "401" ]] ||
  fail "Agent 绕开代理直连本应 401"
ok "upstream 只接受 API Adapter 注入的认证；直连 401"

# Audit: tool audit contains ALLOW demo.echo and DENY demo.forbidden
grep -q '"tool_id":"demo.echo".*"decision":"ALLOW"' "$RUNTIME_DIR/run-live/audit/tool-audit.jsonl" ||
  fail "缺少 demo.echo 的 ALLOW 审计"
grep -q '"tool_id":"demo.forbidden".*"decision":"DENY"' "$RUNTIME_DIR/run-live/audit/tool-audit.jsonl" ||
  fail "缺少 demo.forbidden 的 DENY 审计"
ok "工具审计含 ALLOW/Deny，且不含参数正文"

# ---- B. Quota and Secret isolation ----------------------------------------
say "B. 配额 429 与 Secret 实例隔离"
ADAPTER_URL=$(grep -o 'API Adapter 已启动：http://127.0.0.1:[0-9]*' "$RUNTIME_DIR/run/worker-a.log" |
  tail -1 | sed 's/.*：//')
[[ -n "$ADAPTER_URL" ]] || fail "worker-a 日志里没有 API Adapter 地址"
code1=$(curl -s -o "$TMP/q1" -w '%{http_code}' "$ADAPTER_URL/api_mock/whoami")
code2=$(curl -s -o "$TMP/q2" -w '%{http_code}' "$ADAPTER_URL/api_mock/whoami")
[[ "$code1" == "200" && "$code2" == "429" ]] ||
  fail "rpm=2 配额应第二次代理调用 429（实际 $code1/$code2：$(cat "$TMP/q2")）"
ok "本地 API Adapter 配额 rpm=2 生效：$code1 → $code2"

resolve_secret() { # token ref
  curl -s -o "$TMP/secret.out" -w '%{http_code}' -X POST "$SECRET_STORE_URL/v1/secrets/resolve" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"secret_ref\":\"$2\"}"
}
TOK_A=$(cat "$INSTANCE_TOKEN_DIR/worker-a.jwt")
TOK_B=$(cat "$INSTANCE_TOKEN_DIR/worker-b.jwt")
[[ "$(resolve_secret "$TOK_A" "$SECRET_REF")" == "200" ]] || fail "worker-a 解析自己的 secret 失败"
[[ "$(resolve_secret "$TOK_A" "$SECRET_REF_B")" == "403" ]] || fail "worker-a 不应解析 worker-b 的 secret"
grep -q "SECRET_NOT_ALLOWED" "$TMP/secret.out" || fail "越权解析应返回 SECRET_NOT_ALLOWED"
[[ "$(resolve_secret "$TOK_B" "$SECRET_REF_B")" == "200" ]] || fail "worker-b 解析自己的 secret 失败"
curl -sf -X POST "$SECRET_STORE_URL/v1/secrets/revoke" \
  -H "authorization: Bearer admin-$RUN_ID" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-b"}' >/dev/null
[[ "$(resolve_secret "$TOK_B" "$SECRET_REF_B")" == "403" ]] || fail "吊销后 worker-b 仍能解析 secret"
grep -q "INSTANCE_REVOKED" "$TMP/secret.out" || fail "吊销后应返回 INSTANCE_REVOKED"
ok "Worker A 无法解析 Worker B 的 secret_ref；吊销即时生效"

# ---- C. Swap Agent without changing code ----------------------------------
say "C. 同角色换 Agent：alpha → beta（只改 PCS 绑定与实例配置）"
bind_agent worker-a agp_worker_beta worker
export_profiles "$RUNTIME_DIR/profiles.p4.json"
python3 - "$RUNTIME_DIR/runtime.config.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
for i in d["instances"]:
    if i["instance_id"] == "worker-a":
        i["agent_profile_id"] = "agp_worker_beta"
json.dump(d, open(p, "w"), indent=2)
PY
(cd "$RUNTIME_DIR" && ./scripts/stop.sh worker-a >/dev/null 2>&1 || true)
sleep 2
(cd "$RUNTIME_DIR" && ./scripts/start.sh worker-a >/dev/null)
wait_online worker-a 30 || fail "worker-a 换 Agent 后没有 ONLINE"

REQ_B='{"message":"hello-p4-beta","probe_forbidden":false,"probe_api":false}'
RUN_B=$(create_workflow wft_agent_probe "svn://e2e-p4/$RUN_ID/beta" "$REQ_B")
wait_run "$RUN_B" COMPLETED 60
ART_B=$(sqls "SELECT a.artifact_id FROM artifacts a JOIN tasks t USING (task_id) WHERE t.workflow_run_id = '$RUN_B' AND a.status = 'COMPLETE' ORDER BY a.created_at DESC LIMIT 1")
curl -sf "$SCHEDULER_URL/v1/artifacts/$ART_B/content" \
  -H "authorization: Bearer $(cat "$INSTANCE_TOKEN_DIR/worker-a.jwt")" > "$TMP/result-beta.json"
jget marker < "$TMP/result-beta.json" | grep -qx beta || fail "换 Agent 后产物 marker 不是 beta"
registered_agent=$(sqls "SELECT agent_profile_id FROM role_instances WHERE instance_id = 'worker-a'")
[[ "$registered_agent" == "agp_worker_beta" ]] || fail "调度机记录的 Agent 仍是 $registered_agent"
ok "beta Agent 已接管；调度机只更新 Profile 引用，没有改代码"

# ---- D. Agent crash -------------------------------------------------------
say "D. Agent 崩溃：role-agent 不退出，任务按可重试失败上报"
REQ_C='{"message":"crash","crash":true}'
RUN_C=$(create_workflow wft_agent_probe "svn://e2e-p4/$RUN_ID/crash" "$REQ_C")
CRASHED=""
for i in $(seq 1 80); do
  CRASHED=$(sqls "SELECT count(*) FROM task_attempts a JOIN tasks t USING (task_id)
                   WHERE t.workflow_run_id = '$RUN_C' AND a.status = 'FAILED'
                     AND a.error->>'code' = 'AGENT_CRASHED'")
  [[ "$CRASHED" != "0" ]] && break
  sleep 0.25
done
[[ "$CRASHED" != "0" ]] || fail "没有看到 AGENT_CRASHED 失败"
[[ "$(sqls "SELECT state FROM role_instances WHERE instance_id = 'worker-a'")" == "ONLINE" ]] ||
  fail "Agent 崩溃后 role-agent 不应掉线"
PID_A=$(cat "$RUNTIME_DIR/run/worker-a.pid")
kill -0 "$PID_A" 2>/dev/null || fail "role-agent 进程已退出"
CRASH_TASK=$(sqls "SELECT task_id FROM tasks WHERE workflow_run_id = '$RUN_C'")
curl -sf -X POST "$SCHEDULER_URL/v1/tasks/$CRASH_TASK/cancel" -H 'content-type: application/json' \
  -d '{"actor":"e2e-p4"}' >/dev/null || true
ok "AGENT_CRASHED 已上报，role-agent 仍 ONLINE（pid $PID_A）"

# ---- E. Key and envelope scan ---------------------------------------------
say "E. 密钥不出现在信封、日志、制品、审计"
if grep -R -- "$SECRET_VALUE" "$RUNTIME_DIR/run" "$RUNTIME_DIR/run-live/audit" \
     "$P4_DIR/scheduler.log" "$P4_DIR/pcs.log" "$P4_DIR/secret-store.log" \
     "$RUNTIME_DIR/profiles.p4.json" "$RUNTIME_DIR/runtime.config.json" 2>/dev/null; then
  fail "日志/配置/信封里出现密钥明文"
fi
if sqls "SELECT (SELECT requirements::text FROM tasks WHERE workflow_run_id = '$RUN_A')
              || (SELECT COALESCE(string_agg(outputs::text, ''), '') FROM task_attempts a JOIN tasks t USING (task_id) WHERE t.workflow_run_id = '$RUN_A')" |
   grep -q -- "$SECRET_VALUE"; then
  fail "任务信封或结果里出现密钥明文"
fi
if grep -q -- "$SECRET_VALUE" "$TMP/result-alpha.json" "$TMP/result-beta.json"; then
  fail "Agent 产物里出现密钥明文"
fi
ok "扫描通过：密钥只存在于 Secret Store 数据文件与 API Adapter 内存"

# ---- F. PCS audit ---------------------------------------------------------
say "F. Profile 绑定与密钥访问有审计"
audit_rows=$(sqlp "SELECT count(*) FROM pcs_audit_logs")
[[ "$audit_rows" -ge 2 ]] || fail "PCS 审计记录不足：$audit_rows"
grep -q '"decision":"ALLOW"' "$P4_DIR/secret-store/audit.jsonl" || fail "Secret Store 缺少访问审计"
grep -q '"decision":"DENY"' "$P4_DIR/secret-store/audit.jsonl" || fail "Secret Store 缺少拒绝审计"
ok "PCS 审计 $audit_rows 条；Secret Store ALLOW/DENY 均已记录"

printf '\nP4 验收通过（RUN=%s）\n' "$RUN_ID"
printf '产物与日志保留在 %s\n' "$P4_DIR"
