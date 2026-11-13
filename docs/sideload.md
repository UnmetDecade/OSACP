# Sideloads

> English · [简体中文](sideload.zh-CN.md)

> Version: v4.5 · 2026-11-13
> A sideload is a curl token that lets one device on the LAN drive one host's builders through the control plane.

---

## 1. Model

- A sideload belongs to **exactly one host** and is created from that host's AI Agent studio.
- It is **not an Agent**: no container, no scheduler registration, no heartbeat, no lease of its own.
  Calls go `device → PCS → host's root scheduler → builder`, the same task / lease / fencing path as the admin app.
- A host's studio shows **only its own sideloads**. Folded child hosts keep their own; a sideload can never list
  another host's sideloads. Builders, however, come from the host's root scheduler subtree, because that is the
  set a submitted task can actually run on.
- Because it is not an Agent, the studio draws it as a **host cartoon**, not a robot.

---

## 2. Permissions

Permissions are a closed set. Unknown values are rejected with `SIDELOAD_SCOPE_UNKNOWN` instead of being dropped.

| Scope | Allows |
|---|---|
| `tasks:read` | `GET /tasks`, `GET /tasks/:id`, `GET /tasks/:id/events`, `GET /tasks/:id/artifacts`, `GET /artifacts/:id/download` |
| `tasks:write` | `POST /tasks`, `POST /attachments`, `POST /tasks/:id/cancel`, `/retry`, `/answer` |
| `builders:read` | `GET /builders` (root scheduler subtree) |
| `queue:read` | `GET /queue` |
| `console:run` | Creating `task.console.*` tasks; requires `tasks:write` |

`console:run` is a gate on top of `tasks:write`: a console task executes a shell command on a builder, so it is
never implied by task writing alone.

---

## 3. Admin API

Admin routes use the normal admin Bearer token.

| Method | Path | Scope | Purpose |
|---|---|---|---|
| `POST` | `/api/v1/platform/sideloads` | `host:admin` | Create a token |
| `GET` | `/api/v1/platform/sideloads?host_id=` | `host:read` | List tokens (all or one host) |
| `DELETE` | `/api/v1/platform/sideloads/:id` | `host:admin` | Delete a token |

Create body:

```json
{
  "host_id": "hst_…",
  "name": "laptop",
  "scopes": ["tasks:read", "tasks:write", "builders:read"],
  "expires_in_days": 30
}
```

- `expires_in_days` is optional (1–3650); omit it for a token that never expires.
- The response contains `sideload`, `token`, and `base_url`. **The plaintext token is returned only here**;
  the control plane stores a SHA-256 hash plus the last four characters (`token_hint`).
- Deletion is permanent: the row disappears immediately and the token becomes an unknown token on its next
  call (`403 SIDELOAD_TOKEN_INVALID`). Deleting an already-deleted token returns `SIDELOAD_NOT_FOUND`.

---

## 4. Sideload API

Every request carries the token as `authorization: Bearer sdl_…`. The response bodies are the scheduler's own
task / instance / queue projections, so they match what the admin app sees.

| Method | Path | Permission |
|---|---|---|
| `GET` | `/api/v1/sideload/me` | any valid token |
| `GET` | `/api/v1/sideload/builders` | `builders:read` |
| `GET` | `/api/v1/sideload/tasks?status=&limit=` | `tasks:read` |
| `POST` | `/api/v1/sideload/tasks` | `tasks:write` (+ `console:run` for `task.console.*`) |
| `GET` | `/api/v1/sideload/tasks/:id` | `tasks:read` |
| `GET` | `/api/v1/sideload/tasks/:id/events` | `tasks:read` |
| `POST` | `/api/v1/sideload/tasks/:id/cancel` | `tasks:write` |
| `POST` | `/api/v1/sideload/tasks/:id/retry` | `tasks:write` |
| `POST` | `/api/v1/sideload/tasks/:id/answer` | `tasks:write` |
| `POST` | `/api/v1/sideload/attachments` | `tasks:write` |
| `GET` | `/api/v1/sideload/tasks/:id/artifacts` | `tasks:read` |
| `GET` | `/api/v1/sideload/artifacts/:id/download` | `tasks:read` |
| `GET` | `/api/v1/sideload/queue` | `queue:read` |

### curl

```bash
export SIDELOAD_TOKEN='sdl_…'

# who am I (host, permissions, online state)
curl -sS "$PCS/api/v1/sideload/me" -H "authorization: Bearer $SIDELOAD_TOKEN"

# builders under this host's root scheduler
curl -sS "$PCS/api/v1/sideload/builders" -H "authorization: Bearer $SIDELOAD_TOKEN"

# create a task (target_instance_id is optional; the scheduler picks by W)
curl -sS "$PCS/api/v1/sideload/tasks" \
  -H "authorization: Bearer $SIDELOAD_TOKEN" -H 'content-type: application/json' \
  -d '{"task_type":"task.console.builder","requirements":{"console":{"command":"nproc"}}}'

# status and event stream
curl -sS "$PCS/api/v1/sideload/tasks/<task_id>" -H "authorization: Bearer $SIDELOAD_TOKEN"
curl -sS "$PCS/api/v1/sideload/tasks/<task_id>/events" -H "authorization: Bearer $SIDELOAD_TOKEN"
```

`GET /me` returns the token's host, its scopes, `last_seen_at` and expiry, so a device can check its own rights
without asking an operator.

### Files in and out

The scheduler has a dedicated file channel; a sideload does not need to pack files into stdout.

**Input files.** `POST /api/v1/sideload/attachments` takes JSON `{name, media_type, data_base64}` (24 MiB per
attachment, 32 MiB per request) and returns an attachment reference. Put the references in the task:
`requirements.console.attachments` for a console task, or `requirements.build.attachments` for a build task.
Before the command runs, the builder writes them under `<workspace>/attachments/` and passes the list as
`PLATFORM_ATTACHMENTS`. Any format is stored untouched.

```bash
curl -sS "$PCS/api/v1/sideload/attachments" \
  -H "authorization: Bearer $SIDELOAD_TOKEN" -H 'content-type: application/json' \
  -d "{\"name\":\"data.csv\",\"media_type\":\"text/csv\",\"data_base64\":\"$(base64 < data.csv)\"}"
```

**Output files.** A console task takes `requirements.console.collect`: workspace-relative paths, where a
directory is walked recursively (symlinks are not followed). Limits: 32 paths, 128 files, 64 MiB per file and
256 MiB in total. Every collected file goes through the scheduler's artifact channel, which recomputes SHA-256;
the task output then contains `artifacts` (`name`, `artifact_id`, `sha256`, `size_bytes`, `media_type`) and
`collect_skipped` for anything that could not be taken. Agent and build tasks already upload the artifacts they
declare, and those appear through the same endpoints.

```json
{
  "task_type": "task.console.builder",
  "requirements": {
    "console": {
      "command": "g++ -O2 -std=c++17 hello.cpp -o hello && ./hello > result.txt",
      "collect": ["hello", "result.txt"]
    }
  }
}
```

**Download.** `GET /api/v1/sideload/tasks/:id/artifacts` lists the task's files; then
`GET /api/v1/sideload/artifacts/:id/download` returns the raw bytes with the recorded `content-type`,
`content-disposition` and `x-artifact-sha256` / `x-artifact-name` headers. No JSON wrapping, no format
conversion: a 64 MiB binary arrives byte-for-byte. The recorded name (including its relative directory) is
also in the listing, so a client can restore the tree.

`scripts/sideload-project.mjs` wraps both directions:

```bash
SIDELOAD_TOKEN='sdl_…' PCS_URL='http://192.168.10.110:7901' \
  node scripts/sideload-project.mjs --out tmp/hello-cpp \
  --upload ./input/data.csv \
  --command 'g++ -O2 -std=c++17 hello.cpp -o hello && ./hello > result.txt' \
  --collect .
```

It needs `tasks:write` + `console:run` (and `tasks:read` for the downloads); `--instance <id>` pins a builder.
`--upload` is repeatable, `--collect` defaults to `.` and is repeatable, and the script verifies every downloaded
file against the scheduler's SHA-256 before writing it under `--out`.

---

## 5. Presence and expiry

- `last_seen_at` is written on authenticated calls, throttled to at most once per 30 seconds.
- The studio shows **online** when the last call was within 120 seconds; an expired token always shows as
  expired, even if it called recently.
- Deletion and expiry take effect on the next request: the device receives `403 SIDELOAD_TOKEN_INVALID` after a
  delete, or `403 SIDELOAD_EXPIRED` after its expiry.
- A host with no live scheduler returns `503 SCHEDULER_NOT_DEPLOYED`; the token stays valid and starts working
  again when the scheduler is deployed.

---

## 6. Security notes

- Treat the token as a password. It is shown once; if lost, delete it and create another.
- Intended for a trusted LAN. If PCS is reachable from a wider network, put it behind HTTPS and a firewall/VPN.
- The token only reaches PCS. PCS resolves the host's root scheduler internally; the device never sees the
  scheduler address or its instance credentials.
- `builders` lists the root scheduler's subtree (own host plus folded child hosts) — exactly what a submitted task can run on. Sideload cards themselves stay strictly per host.
- Creation and deletion write `sideload.create` / `sideload.delete` audit records; the token and its hash are
  never logged.

---

## 7. Admin UI

- The sideload strip sits in a row above the root scheduler in the AI Agent studio, with each card connected to
  the scheduler by an animated line. The **Attach sideload** card opens a dialog with a name, permission
  checkboxes and an expiry (7 / 30 / 90 days or never).
- After creating, the dialog shows the plaintext token once, a copy button and the control-plane address.
- Each sideload card shows the host cartoon, online/offline state, the token's last four characters and its tags.
  Clicking it opens permissions, timestamps, the source address and **Delete**.
