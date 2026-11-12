#!/usr/bin/env bash
# Control-plane backup / restore / verification (P7).
#
# Usage:
#   ./backup-restore.sh backup  OUTDIR
#   ./backup-restore.sh restore BACKUP_DIR [target DB suffix, default _restore]
#   ./backup-restore.sh verify  BACKUP_DIR
#
# By default, pg_dump/pg_restore/psql are executed through the docker container pg-sched;
# if a local client is available, set PG_MODE=local.
#
# Backup contents:
#   scheduler.dump / platform_control.dump   pg_dump custom format
#   artifacts.tar                            Optional, scheduler artifact directory
#   manifest.json                            Row counts of key tables and artifact checksums
#   SHA256SUMS
#
# Note: backups contain audit and business data, but not JWT/command private keys or Secret Store key values;
#       the backup directory has permissions 0700, and the restore target DB does not overwrite the original DB.
set -euo pipefail

MODE="${1:-}"
BACKUP_ROOT="${2:-}"
SUFFIX="${3:-_restore}"
PG_MODE="${PG_MODE:-docker}"
PG_CONTAINER="${PG_CONTAINER:-pg-sched}"
PG_USER="${PG_USER:-postgres}"
PG_HOST="${PG_HOST:-127.0.0.1}"
PG_PORT="${PG_PORT:-5432}"
PGPASSWORD="${PGPASSWORD:-sched_dev_pw}"
export PGPASSWORD
SCHED_DB="${SCHED_DB:-scheduler}"
PCS_DB="${PCS_DB:-platform_control}"
ARTIFACT_DIR="${ARTIFACT_DIR:-$HOME/scheduler/data/artifacts}"

SCHED_TABLES=(tasks task_attempts task_events outbox_events artifacts workflow_runs approval_requests role_instances)
PCS_TABLES=(pcs_hosts pcs_deployments pcs_commands pcs_audit_logs agent_profiles api_profiles deployment_plans)

say() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok - %s\n' "$*"; }
fail() { printf 'FAIL - %s\n' "$*" >&2; exit 1; }

psql_db() { # database sql
  if [[ "$PG_MODE" == "docker" ]]; then
    docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$1" -tA -c "$2"
  else
    psql "postgres://$PG_USER:$PGPASSWORD@$PG_HOST:$PG_PORT/$1" -tA -c "$2"
  fi
}

dump_db() { # database > stdout
  if [[ "$PG_MODE" == "docker" ]]; then
    docker exec "$PG_CONTAINER" pg_dump -U "$PG_USER" -d "$1" -Fc
  else
    pg_dump "postgres://$PG_USER:$PGPASSWORD@$PG_HOST:$PG_PORT/$1" -Fc
  fi
}

restore_db() { # database < dump
  if [[ "$PG_MODE" == "docker" ]]; then
    docker exec -i "$PG_CONTAINER" pg_restore -U "$PG_USER" -d "$1" --no-owner --no-privileges
  else
    pg_restore "postgres://$PG_USER:$PGPASSWORD@$PG_HOST:$PG_PORT/$1" --no-owner --no-privileges
  fi
}

db_exists() {
  [[ "$(psql_db postgres "SELECT 1 FROM pg_database WHERE datname='$1'")" == "1" ]]
}

counts_for() { # database tables...
  local db="$1"; shift
  local out="{" first=1 t n
  for t in "$@"; do
    n=$(psql_db "$db" "SELECT count(*) FROM $t" 2>/dev/null || echo "?")
    [[ $first == 1 ]] || out+=","
    first=0
    out+="\"$t\":${n//\"/}"
  done
  out+="}"
  printf '%s' "$out"
}

backup() {
  [[ -n "$BACKUP_ROOT" ]] || fail "用法：backup OUTDIR"
  local ts dir
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  dir="$BACKUP_ROOT/$ts"
  mkdir -p "$dir"
  chmod 700 "$BACKUP_ROOT" "$dir"
  say "备份数据库到 $dir"
  dump_db "$SCHED_DB" > "$dir/scheduler.dump"
  dump_db "$PCS_DB" > "$dir/platform_control.dump"
  [[ -s "$dir/scheduler.dump" && -s "$dir/platform_control.dump" ]] || fail "pg_dump 输出为空"

  if [[ -d "$ARTIFACT_DIR" ]]; then
    tar -C "$(dirname "$ARTIFACT_DIR")" -czf "$dir/artifacts.tar" "$(basename "$ARTIFACT_DIR")"
    ok "制品目录 $(find "$ARTIFACT_DIR" -type f | wc -l) 个文件"
  fi

  python3 - "$dir/manifest.json" \
    "$(counts_for "$SCHED_DB" "${SCHED_TABLES[@]}")" \
    "$(counts_for "$PCS_DB" "${PCS_TABLES[@]}")" <<'PY'
import json, sys
path, sched, pcs = sys.argv[1], sys.argv[2], sys.argv[3]
json.dump({"created_at": __import__("datetime").datetime.utcnow().isoformat() + "Z",
           "scheduler": json.loads(sched), "platform_control": json.loads(pcs)},
          open(path, "w"), indent=2)
PY
  local files="scheduler.dump platform_control.dump manifest.json"
  [[ -f "$dir/artifacts.tar" ]] && files+=" artifacts.tar"
  (cd "$dir" && sha256sum $files > SHA256SUMS)
  chmod 600 "$dir"/*
  ok "备份完成：$dir"
  echo "$dir"
}

restore() {
  [[ -n "$BACKUP_ROOT" ]] || fail "用法：restore BACKUP_DIR [后缀]"
  local dir="$BACKUP_ROOT"
  [[ -f "$dir/scheduler.dump" && -f "$dir/platform_control.dump" ]] || fail "备份目录缺少 dump"
  say "恢复为独立目标库（原库不动）"
  local sched_target="${SCHED_DB}${SUFFIX}" pcs_target="${PCS_DB}${SUFFIX}"
  for pair in "$sched_target:$dir/scheduler.dump" "$pcs_target:$dir/platform_control.dump"; do
    local db="${pair%%:*}" file="${pair#*:}"
    if db_exists "$db"; then
      psql_db postgres "DROP DATABASE \"$db\"" >/dev/null
    fi
    psql_db postgres "CREATE DATABASE \"$db\"" >/dev/null
    restore_db "$db" < "$file"
    ok "已恢复 $db"
  done

  local sched_now pcs_now
  sched_now=$(counts_for "$sched_target" "${SCHED_TABLES[@]}")
  pcs_now=$(counts_for "$pcs_target" "${PCS_TABLES[@]}")
  python3 - "$dir/manifest.json" "$sched_now" "$pcs_now" <<'PY'
import json, sys
m, s, p = json.load(open(sys.argv[1])), json.loads(sys.argv[2]), json.loads(sys.argv[3])
bad = []
for name, want, got in (("scheduler", m["scheduler"], s), ("platform_control", m["platform_control"], p)):
    for k, v in want.items():
        if got.get(k) != v:
            bad.append(f"{name}.{k}: {v} -> {got.get(k)}")
if bad:
    raise SystemExit("行数不一致：" + "; ".join(bad))
print("ok - 关键表行数与备份一致")
PY
  echo "$sched_target $pcs_target"
}

verify() {
  [[ -n "$BACKUP_ROOT" ]] || fail "用法：verify BACKUP_DIR"
  local dir="$BACKUP_ROOT"
  (cd "$dir" && sha256sum -c SHA256SUMS) || fail "备份文件校验和失败"
  python3 - "$dir/manifest.json" \
    "$(counts_for "$SCHED_DB" "${SCHED_TABLES[@]}")" \
    "$(counts_for "$PCS_DB" "${PCS_TABLES[@]}")" <<'PY'
import json, sys
m, s, p = json.load(open(sys.argv[1])), json.loads(sys.argv[2]), json.loads(sys.argv[3])
for name, backed, now in (("scheduler", m["scheduler"], s), ("platform_control", m["platform_control"], p)):
    if backed != now:
        print(f"warn - {name} 与备份时行数不同（备份后仍在写入）：{backed} vs {now}")
    else:
        print(f"ok - {name} 行数与备份一致")
PY
}

case "$MODE" in
  backup) backup ;;
  restore) restore ;;
  verify) verify ;;
  *) echo "用法: $0 {backup OUTDIR|restore BACKUP_DIR [后缀]|verify BACKUP_DIR}" >&2; exit 1 ;;
esac
