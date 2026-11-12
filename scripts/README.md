# 验收与运维脚本

这些脚本只用于**测试环境**：会建库、重置演示数据、启动或停止本机进程，
部分动作依赖 Docker 容器 `pg-sched`。不要在承载真实业务的控制面上直接运行，
运行前先读脚本头部说明。

## 验收脚本

| 脚本 | 阶段 | 覆盖 |
|---|---|---|
| `e2e-p2.sh` | P2 | 注册、领取、租约、fencing、回收、重试与队列统计（两个构建机实例） |
| `e2e-p4.sh` | P4 | Agent Profile、API Profile、Secret 引用、Tool Policy Guard、出站拒绝 |

v3 时代的四角色闭环、审批、TLS/备份/压力验收脚本已随角色删除一起退役，不再适用。

## 支撑脚本

| 脚本 | 用途 |
|---|---|
| `build-app-payload.mjs` | 打调度机与构建机的部署载荷到 `deploy/{scheduler,builder}/app/`（esbuild bundle + SQL + 入口脚本）；镜像保持官方 ubuntu |
| `pki.sh OUTDIR [额外 DNS/IP...]` | 生成内部 CA、PCS/调度机/Secret Store 服务端证书与共享客户端证书；输出 0600 私钥，可重复执行 |
| `backup-restore.sh backup OUTDIR` | `pg_dump -Fc` 两个库，打包制品，写行数清单与 SHA256SUMS；目录 0700 |
| `backup-restore.sh restore BACKUP_DIR [后缀]` | 恢复到独立后缀库（默认 `_restore`），比对关键表行数，不覆盖原库 |
| `backup-restore.sh verify BACKUP_DIR` | 校验备份文件摘要，并对比当前库与备份清单 |
| `load-test.mjs` | 向调度机提交 N 个 `task.build`，统计 p50/p95/max、吞吐，采样 `/proc/meminfo`、`VmRSS` 与 `oom_kill` |
| `p4-mock-upstream.mjs` | P4 验收用的本地 API 上游，带鉴权与配额行为 |
| `seed-cli-agents.mjs` | 把 Claude Code / Codex 的 CLI Agent Profile 注册到 PCS；`--dry-run` 只打印，`--bind <instance>:<provider>` 创建后绑定。镜像必须 digest 固定且在 PCS 白名单内 |
| `../agents/test-cli-agent.mjs` | CLI Agent 适配器的协议级测试（stub CLI，不需要真实模型或凭据） |

### load-test 环境变量

```bash
SCHEDULER_URL=http://127.0.0.1:7801 \
COUNT=100 \
TASK_TYPE=task.build \
TIMEOUT_SECONDS=300 \
MONITOR_PIDS=12345,12346 \
node scripts/load-test.mjs
```

只读取任务状态与 `/proc` 计数，不接触密钥或审计正文。任务未全部完成或
`oom_kill` 增量大于 0 时以非零码退出。

## 备份脚本的默认值

| 变量 | 默认 | 说明 |
|---|---|---|
| `PG_MODE` | `docker` | `docker` 走容器 `pg-sched`；`local` 走本机 `psql`/`pg_dump` |
| `PG_CONTAINER` | `pg-sched` | Docker 容器名 |
| `SCHED_DB` / `PCS_DB` | `scheduler` / `platform_control` | 源库 |
| `ARTIFACT_DIR` | `$HOME/scheduler/data/artifacts` | 可选打包的制品目录 |
| `PG_USER` / `PGPASSWORD` | `postgres` / `sched_dev_pw` | 仅测试环境默认值 |

备份包含审计与业务数据，但**不含** JWT、命令私钥或 Secret Store 的密钥值；
恢复前先确认目标库后缀，脚本不会覆盖源库。


## CLI Agent Profile

```bash
ADMIN_TOKEN=... \
AGENT_IMAGE=registry.example/agents/claude@sha256:<64hex> \
PLATFORM_DIR=/opt/platform \
AGENT_NODE=node \
AGENT_PASS_ENV=ANTHROPIC_API_KEY \
node scripts/seed-cli-agents.mjs --bind builder-ubuntu22-a:claude
```

- 令牌只从环境变量读取，不写进脚本、URL 或输出。
- `AGENT_PASS_ENV` 只列变量名；不设置时按 provider 取默认值：Claude Code 放行
  `ANTHROPIC_API_KEY,ANTHROPIC_BASE_URL`，Codex 放行 `DEEPSEEK_API_KEY,CODEX_HOME`。
- 容器环境到 Agent 适配器还有一层放行：`PLATFORM_AGENT_PASS_ENV`（见 `deploy/README.md`）。
- 外部 CLI 默认不继承宿主环境，避免无关凭据被 Agent 读取。
- 目标主机必须已安装对应 CLI；缺失时任务失败为 `AGENT_NOT_READY`，不会静默改用确定性执行器。
- Profile 的 `version` 默认取本机 `<cli> --version`（如 `2.1.322` / `0.167.1`），这样 UI 上的
  「Claude Code · builder · v2.1.322」和镜像里的 CLI 对得上；种子上游机器没装 CLI 时用
  `AGENT_CLAUDE_VERSION` / `AGENT_CODEX_VERSION` 显式指定。
- 注册只改 PCS 控制面；Host Runtime 需要滚动重启实例才会加载新 Agent。
- 执行路径与 `.claude`/`.codex` 用户目录无关：Adapter 把 `HOME` 指向一次性任务工作区。
