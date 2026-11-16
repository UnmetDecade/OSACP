# secret-store · Secret Store reference implementation

> English · [简体中文](README.zh-CN.md)

Implements the Agent/API profiles and Secret Store section of [../docs/admin-app.md](../docs/admin-app.md). PCS profiles store only
`secret://...` references; this process resolves those references into short-lived credentials using the **instance identity**, and hands the value to the API adapter in memory only.

**Not Vault/KMS**: the file backend is intended for local and acceptance environments. When replacing it for production, keep the same contract:
resolve per instance identity, store references only, support revocation, and never record values in audit.

## Security properties

- **Instance-level isolation**: resolve requests must carry an ES256 instance JWT issued by PCS; `sub` determines which references can be read.
  Worker A cannot read Worker B's `secret_ref` even with its own token (`SECRET_NOT_ALLOWED`).
  The exception is the policy `"*"`: platform-level secrets (provider keys written by the console for an API profile) are readable by every instance.
- **Short-lived credentials**: each resolution returns a fresh expiry (300s by default, 1h maximum).
- **Rotation**: every resolution re-reads the secrets file; a replacement takes effect on the next call.
- **Revocation**: after `/v1/secrets/revoke`, that instance immediately gets `INSTANCE_REVOKED`.
- **File permissions**: the secrets and policy files must be 0600 or stricter, otherwise startup is refused.
- **Audit**: records the action, instance, reference, decision and error code; **never records credential values**.
- Binds to a private address only and is never exposed to the WAN; holds no JWT private key (only the PCS public key).

## Running

```bash
npm install
SECRET_STORE_HOST=127.0.0.1 \
SECRET_STORE_SECRETS_FILE=/secure/secrets.json \
SECRET_STORE_POLICY_FILE=/secure/policy.json \
SECRET_STORE_AUDIT_FILE=/secure/audit.jsonl \
SECRET_STORE_ADMIN_TOKEN=... \
PCS_PUBLIC_KEY_FILE=../pcs-issuer/keys/public.pem \
npm start
```

`SECRET_STORE_HOST=127.0.0.1` (the default) only serves processes on the same machine. Role containers cannot
reach loopback, so a deployment that binds API Profiles needs a container-visible address:
on Linux the host's LAN IP, on macOS `0.0.0.0` plus a reachable container URL such as the Docker bridge gateway.

### Deployment

`scripts/deploy.sh` starts the store for you and wires PCS to it — data files and the admin token live under
`~/.config/platform/secret-store/` (0600), the log next to them, and PCS receives:

| Variable | Meaning |
|---|---|
| `PCS_SECRET_STORE_URL` | Address PCS itself uses for key writes (`PUT /v1/secrets`) |
| `PCS_SECRET_STORE_CONTAINER_URL` | Address containers use to resolve `secret://`; falls back to the URL above |
| `PCS_SECRET_STORE_ADMIN_TOKEN` | Set from `admin-token`; PCS never returns it to the browser |

The store starts once and is reused on later runs (the script probes `/healthz` first); stop the process yourself
if you need it restarted, since a running store keeps serving the data and token already on disk.

Data file formats (both must be 0600):

```json
// secrets.json: reference -> value
{ "secret://apis/mock": "<credential>" }

// policy.json: instance_id -> allowed references
// "*" is a platform-level secret: readable by every enrolled instance (API provider keys written from the console)
{ "worker-a": ["secret://apis/mock"], "worker-b": ["secret://apis/worker-b-only"] }
```

### Writing (admin side)

```bash
curl -X PUT http://127.0.0.1:7902/v1/secrets \
  -H "authorization: Bearer $SECRET_STORE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"secret_ref":"secret://apis/deepseek","value":"sk-..."}'
```

Requires the admin token; writes `secrets.json` atomically (0600) and adds the reference to the policy's `"*"`.
Instances keep resolving with their own JWT. Audit records only the action and reference, never the value.
When you enter an API key in the admin app, PCS calls this endpoint on your behalf, so the value never enters PCS.

| Environment variable | Default | Description |
|---|---|---|
| `SECRET_STORE_HOST` | `127.0.0.1` | Listen address; loopback is invisible to role containers, so use a private host address when they must resolve |
| `SECRET_STORE_PORT` | `7902` | |
| `SECRET_STORE_SECRETS_FILE` | required | Mapping of references to values, 0600 |
| `SECRET_STORE_POLICY_FILE` | required | Per-instance authorization of references, 0600 |
| `SECRET_STORE_AUDIT_FILE` | unset | JSONL audit, 0600 |
| `SECRET_STORE_TTL_SECONDS` | `300` | Credential lifetime, 1–3600 |
| `SECRET_STORE_AUDIENCE` | `scheduler` | Audience of instance JWTs (same as the scheduler) |
| `SECRET_STORE_ADMIN_TOKEN` | unset | Bearer for the write and revoke endpoints; when unset, both endpoints always return 401 |
| `PCS_PUBLIC_KEY_FILE` | `../pcs-issuer/keys/public.pem` | Verification public key |
| `SECRET_STORE_TLS_CERT_FILE` | unset | Server certificate; must be configured together with `SECRET_STORE_TLS_KEY_FILE` |
| `SECRET_STORE_TLS_KEY_FILE` | unset | Server private key |
| `SECRET_STORE_TLS_CA_FILE` | unset | CA for client certificate verification; required when mTLS is enabled |
| `SECRET_STORE_MTLS` | unset | Set to `1` to require client certificates |

TLS / mTLS use the same internal CA as PCS and the scheduler:

```bash
../scripts/pki.sh /secure/pki
SECRET_STORE_TLS_CERT_FILE=/secure/pki/secret-store.crt \
SECRET_STORE_TLS_KEY_FILE=/secure/pki/secret-store.key \
SECRET_STORE_TLS_CA_FILE=/secure/pki/ca.crt \
SECRET_STORE_MTLS=1 \
npm start
```

> The client (the API adapter inside the role container) currently uses `fetch` and trusts only system CAs. If the Secret Store
> uses the internal CA, set `NODE_EXTRA_CA_CERTS=/secure/pki/ca.crt` for that process, or install the CA
> into the container's system trust store; the mTLS client certificate is also not yet wired into this client path.

## Endpoints

| Method | Path | Authentication | Description |
|---|---|---|---|
| GET | `/healthz` | none | Liveness and TTL |
| POST | `/v1/secrets/resolve` | instance JWT | body `{secret_ref}` → `{credential, expires_at}` |
| POST | `/v1/secrets/revoke` | admin token | body `{instance_id}`, revokes that instance immediately |

Do not inject the instance JWT or this service's address into Agent or adapter child processes: only the
API adapter client in `role-agent` holds them.

## Tests

```bash
npm test        # 5 cases
```

Covers: resolution per instance policy, cross-instance denial, immediate revocation, re-read after rotation, refusal of overly permissive file permissions,
and JWT signature/audience/`sub` validation.
