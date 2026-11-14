# 为 OSACP 贡献代码

> [English](CONTRIBUTING.md) · 简体中文

感谢你愿意改进 OSACP。这个项目是面向 AI 编程 Agent 的自托管算力与调度平台。聚焦、带测试的小改动最容易评审和合并。

开始之前，请先阅读 [docs/architecture.zh-CN.md](docs/architecture.zh-CN.md) 和 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。这里的安全模型是有意为之：构建机以 root 运行，平台假设处于可信网络，PCS 永远不执行 Docker 命令。

## 环境要求

- Node.js 22
- PostgreSQL 16（调度机与 PCS 的测试套件需要）
- Docker（镜像、Compose 和验收脚本需要）
- 类 Unix shell；脚本使用 `bash`

## 准备开发环境

```bash
git clone https://github.com/UnmetDecade/OSACP.git
cd OSACP

cd scheduler    && npm ci
cd ../pcs-issuer  && npm ci
cd ../host-runtime && npm ci
cd ../secret-store && npm ci
cd ../admin-app   && npm ci
```

在本地启动 PostgreSQL（或使用 Compose 里的数据库），然后创建测试库：

```sql
CREATE DATABASE scheduler_test;
CREATE DATABASE platform_control_test;
```

`scheduler/` 和 `pcs-issuer/` 的 `npm test` 默认连接 `postgres://postgres:sched_dev_pw@127.0.0.1:5432/...`，可以用 `DATABASE_URL_TEST` / `PCS_DATABASE_URL_TEST` 覆盖。

## 提交 PR 前要跑的检查

在 CI 相同的命令下自测：

```bash
cd scheduler    && npm run typecheck && npm test
cd pcs-issuer   && npm run typecheck && npm test
cd host-runtime && npm run typecheck && npm test
cd secret-store && npm run typecheck && npm test
cd admin-app    && npm run lint && npm test && npm run build
```

数据库测试会清空所在数据库，因此会拒绝连接库名不以 `_test` 结尾的数据库。不要把测试指向真实部署。

`scripts/e2e-p2.sh` 和 `scripts/e2e-p4.sh` 是整机验收测试，需要预先准备好的环境（已注册的调度机、host runtime、已签发的实例令牌），详见 [scripts/README.zh-CN.md](scripts/README.zh-CN.md)。它们会重置数据库，不进入 PR CI，请在一次性测试机上运行。

## 代码风格

- TypeScript 开启严格模式。不要新增显式 `any`；用行类型或 `unknown` + 收窄代替。
- 代码注释使用英文。
- 保持模块职责单一。文件已经很大时，欢迎抽出内聚的一小块；不要把无关重构混进 bug 修复。
- `pcs-issuer/src/service.ts` 是后端最大的模块，各段落互相引用（主机 ↔ 部署 ↔ 侧载），不能用继承拆分。请用组合方式抽出内聚的查询/映射辅助函数。
- 管理界面使用自己的 `oxlint` 配置。不要引入新的告警。
- 不要手工编辑 `deploy/scheduler/app/` 或 `deploy/builder/app/`，它们由脚本生成：

  ```bash
  node scripts/build-app-payload.mjs
  ```

  CI 会重新构建并检查提交的产物是否与源码一致。

## 文档

每个 Markdown 文档都有英文默认版和 `.zh-CN.md` 中文版：

- 英文：`NAME.md`
- 中文：`NAME.zh-CN.md`

在 H1 下方放语言切换链接，文档间链接要指向读者当前语言的版本。行为变更时，请同步更新两种版本（或在同一个 PR 里补上中文文件）。

## 提交与 PR

- commit subject 用英文、祈使语气，控制在约 72 个字符以内。
- 一个 PR 只做一件事。行为变更要带测试，界面变更要附截图或 GIF。
- 关联对应 issue（`Closes #123`）。
- `main` 的建议保护规则：要求 CI（`scheduler`、`pcs-issuer`、`host-runtime`、`secret-store`、`admin-app`、`payload`）通过、要求线性历史、禁止强制推送与删除。请在仓库设置或分支保护 API 中启用；规则建立之前，直接推送不受这些检查约束。
- 不要提交凭据、私钥、真实主机地址、模型 API Key 或生产数据。

## 发版

只从 `main` 发版，且 CI 必须是通过的：

```bash
git switch main && git pull
git tag -a v4.5.1 -m "v4.5.1 — 简短说明"
git push origin v4.5.1
```

tag 会再次触发 CI；全部 job 成功后，`release` job 会自动创建 GitHub Release。不要移动或删除已发布的 tag，修问题请发新的补丁版本。

## 报告安全问题

漏洞不要开公开 issue。请按 [SECURITY.zh-CN.md](SECURITY.zh-CN.md) 使用 GitHub Security Advisories。

## 许可证

提交贡献即表示你同意按项目的 [MIT License](LICENSE) 授权。
