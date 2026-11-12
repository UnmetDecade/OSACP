# Security Policy

> English · [简体中文](SECURITY.zh-CN.md)

## Reporting vulnerabilities

Please report privately through GitHub **Security Advisories** (repository → Security → Report a vulnerability).
Do not post credentials, private keys, host addresses or full exploit details in public issues.

When reporting, include: affected components, reproduction steps, impact, and a suggested fix direction (if any).

## Supported scope

The project is at v4.x; security fixes target the current main branch only.

## Deliberate design trade-offs

This platform is intended for **R&D teams on a trusted internal network**. The following behaviors are intentional, not vulnerabilities:

- Builders run as `root` by default, with full SSH access, and can install software and reach the external network.
- The platform has no RBAC, approval gates or permission matrix; anyone who can access the admin app can perform every operation.
- Chat and container terminals are ordinary tasks; the terminal has no command allowlist (it is equivalent to SSH).

Deployments should therefore, at minimum:

- Never expose 7901 (PCS), 8443 (scheduler API), 2200 / 2222–2231 (SSH) directly to the public internet.
- When the admin app is publicly reachable, put a TLS reverse proxy in front of it and add VPN or basic auth on top.
- Rotate the PCS admin token and host enrollment tokens regularly.

## Credential handling

- Private keys, `.env`, `*.local` and instance JWTs never enter the repository (see `.gitignore`).
- SSH private keys stored by PCS are encrypted with AES-256-GCM; the API only returns a fingerprint.
- Agent/API profiles store only `secret://` references; the Secret Store resolves short-lived credentials per instance identity, and audit records never contain credential values.
- Model credentials are injected into the container environment only at run time, and must pass two explicit gates: `PLATFORM_AGENT_PASS_ENV` and the profile's `--pass-env`.

If you find a credential that was committed by mistake, revoke it immediately and explain it in the report — do not just open a PR that deletes the file.
