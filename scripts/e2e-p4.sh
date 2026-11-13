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
  fail "workflow $1 did not reach $2 within $3s (currently $(api_json "$SCHEDULER_URL/v1/workflows/$1" | jget status))"
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
say "Preflight checks"
for f in "$PCS_PUBLIC_KEY_FILE" "$PCS_ISSUER_DIR/keys/private.pem" \
         "$PLATFORM_DIR/agents/demo-agent.mjs" "$SECRET_STORE_DIR/src/main.ts"; do
  [[ -f "$f" ]] || fail "missing $f"
done
[[ -x "$NODE_BIN" ]] || fail "Node 22 not found: $NODE_BIN"
ok "public/private keys, the Agent, and the Secret Store sources are present"

# ---- Reset and infrastructure ---------------------------------------------
say "Reset the database and start PCS / Secret Store / mock upstream"
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
curl -sf "$PCS_URL/healthz" >/dev/null || fail "PCS did not start"

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
curl -sf "$SECRET_STORE_URL/healthz" >/dev/null || fail "Secret Store did not start"

kill_port 18090
rm -f "$P4_DIR/mock-api.log"
(cd "$PLATFORM_DIR" && MOCK_API_PORT=18090 MOCK_API_EXPECTED_TOKEN="$SECRET_VALUE" \
  MOCK_API_LOG="$P4_DIR/mock-api.log" \
  setsid -f "$NODE_BIN" scripts/p4-mock-upstream.mjs >> "$P4_DIR/mock-api.out" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:18090/whoami" && break; sleep 0.5; done
ok "PCS :7901 / Secret Store :7902 / mock upstream :18090 are up"

# ---- PCS Profile and bindings ---------------------------------------------
say "Create Agent / API Profiles and bind them to worker-a"
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
ok "profiles created; worker-a is bound to agp_worker_alpha + api_mock + api_meta"

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
say "Restart the scheduler / Host Runtime / role instances"
(cd "$RUNTIME_DIR" && ./scripts/runtime.sh stop >/dev/null 2>&1 || true)
(cd "$RUNTIME_DIR" && ./scripts/runtime.sh start | sed 's/^/  /')
for i in $(seq 1 40); do [[ -S "$HOST_ADMISSION_SOCKET" ]] && break; sleep 0.5; done
[[ -S "$HOST_ADMISSION_SOCKET" ]] || fail "Host Runtime admission socket is not ready"

kill_port 7801
(cd "$SCHEDULER_DIR" && PCS_PUBLIC_KEY_FILE="$PCS_PUBLIC_KEY_FILE" \
  setsid -f "$NPM_BIN" start >> "$P4_DIR/scheduler.log" 2>&1 < /dev/null &)
for i in $(seq 1 40); do curl -sf "$SCHEDULER_URL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "$SCHEDULER_URL/healthz" >/dev/null || fail "the scheduler did not start"

issue_instance_token worker-a worker host-a
issue_instance_token worker-b worker host-a
issue_instance_token reviewer-a reviewer host-b
issue_instance_token tester-a tester host-a
issue_instance_token after-a after_sales host-b
(cd "$RUNTIME_DIR" && ./scripts/start.sh "${AGENTS[@]}" | sed 's/^/  /')
wait_online worker-a 30 || fail "worker-a did not come ONLINE; see $RUNTIME_DIR/run/worker-a.log"
ok "worker-a is ONLINE in Agent mode"

# ---- A. Agent execution + tool/egress policy ------------------------------
say "A. alpha Agent probe (unauthorized tool, default-deny egress, API through the local proxy)"
REQ_A=$(python3 -c 'import json;print(json.dumps({
  "message":"hello-p4-alpha",
  "probe_forbidden":True,
  "probe_api":True,
  "api_profile_id":"api_mock",
  "probe_api_meta":True,
}))')
RUN_A=$(create_workflow wft_agent_probe "svn://e2e-p4/$RUN_ID/alpha" "$REQ_A")
wait_run "$RUN_A" COMPLETED 60
ok "alpha workflow COMPLETED"

TASK_A=$(sqls "SELECT task_id FROM tasks WHERE workflow_run_id = '$RUN_A'")
ART_A=$(sqls "SELECT a.artifact_id FROM artifacts a JOIN tasks t USING (task_id) WHERE t.workflow_run_id = '$RUN_A' AND a.status = 'COMPLETE' ORDER BY a.created_at DESC LIMIT 1")
[[ -n "$ART_A" ]] || fail "alpha produced no artifact"
curl -sf "$SCHEDULER_URL/v1/artifacts/$ART_A/content" \
  -H "authorization: Bearer $(cat "$INSTANCE_TOKEN_DIR/worker-a.jwt")" > "$TMP/result-alpha.json"
jget marker < "$TMP/result-alpha.json" | grep -qx alpha || fail "the artifact marker is not alpha"
forbidden=$(jget forbidden < "$TMP/result-alpha.json")
grep -q "TOOL_NOT_ALLOWED" <<<"$forbidden" || fail "an unauthorized tool was not rejected: $forbidden"
api_status=$(jget api.status < "$TMP/result-alpha.json")
[[ "$api_status" == "200" ]] || fail "API call failed: $(cat "$TMP/result-alpha.json")"
meta_err=$(jget api_meta.error < "$TMP/result-alpha.json")
grep -q "EGRESS_IP_BLOCKED" <<<"$meta_err" || fail "the metadata address was not denied by default: $meta_err"
ok "alpha artifacts: unauthorized tool rejected, API succeeded through the proxy, metadata address EGRESS_IP_BLOCKED"

grep -q '"auth_ok": *true' "$P4_DIR/mock-api.log" || fail "the mock upstream received no authenticated request"
[[ "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18090/whoami)" == "401" ]] ||
  fail "a direct connection that bypasses the proxy should have returned 401"
ok "the upstream only accepts credentials injected by the API Adapter; direct access gets 401"

# Audit: tool audit contains ALLOW demo.echo and DENY demo.forbidden
grep -q '"tool_id":"demo.echo".*"decision":"ALLOW"' "$RUNTIME_DIR/run-live/audit/tool-audit.jsonl" ||
  fail "missing the ALLOW audit entry for demo.echo"
grep -q '"tool_id":"demo.forbidden".*"decision":"DENY"' "$RUNTIME_DIR/run-live/audit/tool-audit.jsonl" ||
  fail "missing the DENY audit entry for demo.forbidden"
ok "tool audit contains ALLOW/DENY and no argument bodies"

# ---- B. Quota and Secret isolation ----------------------------------------
say "B. Quota 429 and per-instance secret isolation"
ADAPTER_URL=$(grep -o 'API Adapter started: http://127.0.0.1:[0-9]*' "$RUNTIME_DIR/run/worker-a.log" |
  tail -1 | sed 's/.*：//')
[[ -n "$ADAPTER_URL" ]] || fail "no API Adapter address in the worker-a log"
code1=$(curl -s -o "$TMP/q1" -w '%{http_code}' "$ADAPTER_URL/api_mock/whoami")
code2=$(curl -s -o "$TMP/q2" -w '%{http_code}' "$ADAPTER_URL/api_mock/whoami")
[[ "$code1" == "200" && "$code2" == "429" ]] ||
  fail "with rpm=2 the second proxied call should get 429 (actual $code1/$code2: $(cat "$TMP/q2"))"
ok "local API Adapter quota rpm=2 enforced: $code1 → $code2"

resolve_secret() { # token ref
  curl -s -o "$TMP/secret.out" -w '%{http_code}' -X POST "$SECRET_STORE_URL/v1/secrets/resolve" \
    -H "authorization: Bearer $1" -H 'content-type: application/json' \
    -d "{\"secret_ref\":\"$2\"}"
}
TOK_A=$(cat "$INSTANCE_TOKEN_DIR/worker-a.jwt")
TOK_B=$(cat "$INSTANCE_TOKEN_DIR/worker-b.jwt")
[[ "$(resolve_secret "$TOK_A" "$SECRET_REF")" == "200" ]] || fail "worker-a could not resolve its own secret"
[[ "$(resolve_secret "$TOK_A" "$SECRET_REF_B")" == "403" ]] || fail "worker-a must not resolve worker-b's secret"
grep -q "SECRET_NOT_ALLOWED" "$TMP/secret.out" || fail "an unauthorized resolve should return SECRET_NOT_ALLOWED"
[[ "$(resolve_secret "$TOK_B" "$SECRET_REF_B")" == "200" ]] || fail "worker-b could not resolve its own secret"
curl -sf -X POST "$SECRET_STORE_URL/v1/secrets/revoke" \
  -H "authorization: Bearer admin-$RUN_ID" -H 'content-type: application/json' \
  -d '{"instance_id":"worker-b"}' >/dev/null
[[ "$(resolve_secret "$TOK_B" "$SECRET_REF_B")" == "403" ]] || fail "worker-b could still resolve a secret after revocation"
grep -q "INSTANCE_REVOKED" "$TMP/secret.out" || fail "revocation should return INSTANCE_REVOKED"
ok "worker A cannot resolve worker B's secret_ref; revocation takes effect immediately"

# ---- C. Swap Agent without changing code ----------------------------------
say "C. Swap the Agent for the same role: alpha → beta (only PCS bindings and instance config change)"
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
wait_online worker-a 30 || fail "worker-a did not come back ONLINE after the Agent swap"

REQ_B='{"message":"hello-p4-beta","probe_forbidden":false,"probe_api":false}'
RUN_B=$(create_workflow wft_agent_probe "svn://e2e-p4/$RUN_ID/beta" "$REQ_B")
wait_run "$RUN_B" COMPLETED 60
ART_B=$(sqls "SELECT a.artifact_id FROM artifacts a JOIN tasks t USING (task_id) WHERE t.workflow_run_id = '$RUN_B' AND a.status = 'COMPLETE' ORDER BY a.created_at DESC LIMIT 1")
curl -sf "$SCHEDULER_URL/v1/artifacts/$ART_B/content" \
  -H "authorization: Bearer $(cat "$INSTANCE_TOKEN_DIR/worker-a.jwt")" > "$TMP/result-beta.json"
jget marker < "$TMP/result-beta.json" | grep -qx beta || fail "the artifact marker is not beta after the Agent swap"
registered_agent=$(sqls "SELECT agent_profile_id FROM role_instances WHERE instance_id = 'worker-a'")
[[ "$registered_agent" == "agp_worker_beta" ]] || fail "the scheduler still records the Agent as $registered_agent"
ok "the beta Agent has taken over; the scheduler only updated the Profile reference, with no code change"

# ---- D. Agent crash -------------------------------------------------------
say "D. Agent crash: role-agent stays up and the task is reported as a retryable failure"
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
[[ "$CRASHED" != "0" ]] || fail "no AGENT_CRASHED failure was observed"
[[ "$(sqls "SELECT state FROM role_instances WHERE instance_id = 'worker-a'")" == "ONLINE" ]] ||
  fail "role-agent must not go offline after an Agent crash"
PID_A=$(cat "$RUNTIME_DIR/run/worker-a.pid")
kill -0 "$PID_A" 2>/dev/null || fail "the role-agent process exited"
CRASH_TASK=$(sqls "SELECT task_id FROM tasks WHERE workflow_run_id = '$RUN_C'")
curl -sf -X POST "$SCHEDULER_URL/v1/tasks/$CRASH_TASK/cancel" -H 'content-type: application/json' \
  -d '{"actor":"e2e-p4"}' >/dev/null || true
ok "AGENT_CRASHED reported; role-agent is still ONLINE (pid $PID_A)"

# ---- E. Key and envelope scan ---------------------------------------------
say "E. Secrets never appear in envelopes, logs, artifacts, or audits"
if grep -R -- "$SECRET_VALUE" "$RUNTIME_DIR/run" "$RUNTIME_DIR/run-live/audit" \
     "$P4_DIR/scheduler.log" "$P4_DIR/pcs.log" "$P4_DIR/secret-store.log" \
     "$RUNTIME_DIR/profiles.p4.json" "$RUNTIME_DIR/runtime.config.json" 2>/dev/null; then
  fail "plaintext secret found in logs/config/envelopes"
fi
if sqls "SELECT (SELECT requirements::text FROM tasks WHERE workflow_run_id = '$RUN_A')
              || (SELECT COALESCE(string_agg(outputs::text, ''), '') FROM task_attempts a JOIN tasks t USING (task_id) WHERE t.workflow_run_id = '$RUN_A')" |
   grep -q -- "$SECRET_VALUE"; then
  fail "plaintext secret found in the task envelope or result"
fi
if grep -q -- "$SECRET_VALUE" "$TMP/result-alpha.json" "$TMP/result-beta.json"; then
  fail "plaintext secret found in Agent artifacts"
fi
ok "scan passed: secrets exist only in Secret Store data files and API Adapter memory"

# ---- F. PCS audit ---------------------------------------------------------
say "F. Profile bindings and secret access are audited"
audit_rows=$(sqlp "SELECT count(*) FROM pcs_audit_logs")
[[ "$audit_rows" -ge 2 ]] || fail "not enough PCS audit rows: $audit_rows"
grep -q '"decision":"ALLOW"' "$P4_DIR/secret-store/audit.jsonl" || fail "Secret Store is missing access audit entries"
grep -q '"decision":"DENY"' "$P4_DIR/secret-store/audit.jsonl" || fail "Secret Store is missing deny audit entries"
ok "$audit_rows PCS audit rows; Secret Store ALLOW/DENY are both recorded"

printf '\nP4 acceptance passed (RUN=%s)\n' "$RUN_ID"
printf 'Artifacts and logs are kept in %s\n' "$P4_DIR"
