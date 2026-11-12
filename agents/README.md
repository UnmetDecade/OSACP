# CLI Agent Adapter

> English · [简体中文](README.zh-CN.md)

Connects command-line agents such as Claude Code and Codex to the platform's stdio JSON-RPC 2.0 boundary.

| File | Purpose |
|---|---|
| `cli-agent.mjs` | Production adapter: hands the task and workspace to an external CLI and maps stdout to `agent.result` |
| `demo-agent.mjs` | Minimal reference implementation for understanding the protocol boundary |
| `test-cli-agent.mjs` | Protocol-level smoke test (stub CLI; no real model or credentials needed) |
| `fixtures/` | Stub CLIs used by the tests |

## Boundary

- The adapter only receives the task, workspace and tool handle; it cannot see the instance token, Secret Store, or host directories.
- The external CLI's stdout/stderr is captured; only the adapter's own stdout is the protocol channel.
- `PLATFORM_TOOL_TOKEN` / `PLATFORM_API_PROXY` / `PLATFORM_API_PROFILES` are not passed to the external CLI; all other variables are allowed through one by one via `--pass-env`.
- Each run uses the working directory assigned by the platform; cancellation kills the process group and leaves no orphans.

## Usage

Example Profile `entrypoint` / `args`:

```json
{
  "entrypoint": ["node", "/opt/platform/agents/cli-agent.mjs"],
  "args": ["--provider", "claude", "--pass-env", "ANTHROPIC_API_KEY"]
}
```

Supported providers: `claude`, `codex`, `custom` (together with `--command`).
Common flags: `--cli-arg`, `--extra-arg`, `--prompt-stdin`, `--max-wall`,
`--no-result-file`, `--pass-env`.

## Tests

```bash
node agents/test-cli-agent.mjs
```
