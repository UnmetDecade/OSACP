# CLI Agent 适配器

> [English](README.md) · 简体中文

把 Claude Code / Codex 等命令行 Agent 接到平台的 stdio JSON-RPC 2.0 边界上。

| 文件 | 作用 |
|---|---|
| `cli-agent.mjs` | 生产适配器：把任务与工作区交给外部 CLI，把 stdout 映射为 `agent.result` |
| `demo-agent.mjs` | 最小参考实现，用于理解协议边界 |
| `test-cli-agent.mjs` | 协议级冒烟测试（stub CLI，不需要真实模型或凭据） |
| `fixtures/` | 测试用的 stub CLI |

## 边界

- 适配器只拿到任务、工作区和工具句柄，拿不到实例令牌、Secret Store 或宿主机目录。
- 外部 CLI 的 stdout/stderr 被捕获，只有适配器自己的 stdout 是协议通道。
- 不把 `PLATFORM_TOOL_TOKEN` / `PLATFORM_API_PROXY` / `PLATFORM_API_PROFILES`
  传给外部 CLI；其余变量由 `--pass-env` 逐项放行。
- 每次执行使用平台分配的工作目录；取消时杀进程组，不留孤儿。

## 用法

Profile 的 `entrypoint` / `args` 示例：

```json
{
  "entrypoint": ["node", "/opt/platform/agents/cli-agent.mjs"],
  "args": ["--provider", "claude", "--pass-env", "ANTHROPIC_API_KEY"]
}
```

支持的 provider：`claude`、`codex`、`custom`（配合 `--command`）。
常用参数：`--cli-arg`、`--extra-arg`、`--prompt-stdin`、`--max-wall`、
`--no-result-file`、`--pass-env`。

## 测试

```bash
node agents/test-cli-agent.mjs
```
