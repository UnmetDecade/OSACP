# 更新日志

> [English](CHANGELOG.md) · 简体中文

这里记录 OSACP 的重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [未发布]

## [4.6.0] - 2026-11-15

### 新增

- 一条命令的演示模式（`scripts/demo.sh`），带示例工程剧情、重建/停止参数和停止说明。
- 部署能力开关（SSH/终端与对话），重新部署后保留，并可在实例详情页修改。
- 账号登录与注册：第一个账号成为管理员，之后的注册需要审批；角色预设与自定义权限；会话 + CSRF 防护；按账号的操作记录；密码复杂度策略。
- 任务的显式人工介入阶段（`answer`、`review`、`blocked`、`waiting`），支持列表筛选和详情提示。
- 版本化准入策略与不可变的按任务授权（mandate），覆盖管理端与侧载入口，并提供策略与授权查看。
- 线程：任务与消息归入一次会话；发送消息会创建续接任务，继承目标、资源档和自主程度；并按线程维护带游标的 outbox 订阅。
- Outbox effect：命名拉取消费者，持久游标、可选事件类型过滤、ack/nack 重试记账、暂停/恢复和滞后统计。
- 管理界面新增独立的「策略」页，策略与授权记录从账号页移出。

### 变更

- 单机部署（PCS + 管理界面）成为唯一支持的部署路径，脚本端到端完成部署。
- Debian/Ubuntu、Fedora 和 macOS 上自动安装 Node 与 Docker；README 增加自动安装与手动安装的对照表。
- 支持 macOS 主机：容器使用 Docker 网桥网关，可用内存取自 `vm_stat`，并为容器安装 Linux Agent。
- 管理界面布局：构建机、任务、日志页固定高度；任务详情拆为「概览 / 线程 / 事件」标签；分段控件更清晰；页面本身不滚动。
- README：恢复演示模式并补充停止命令，强调不要把管理界面端口暴露到公网，改用侧载令牌。

## [4.5.1] - 2026-11-14

### 新增

- 双语交互式架构图：平台总览、侧载接入模型，以及“一台调度机 + N 台开发机”的具体示例。
- README 新增示例工程架构章节，说明可落地的项目形态。
- 文档双语化：每个 Markdown 文档都有英文默认版和 `.zh-CN.md` 中文版，带语言切换和按语言跳转的链接。
- 贡献者公约、贡献指南、更新日志、issue 表单和 PR 模板。
- 管理界面单元测试（Vitest + Testing Library）、覆盖率报告和严格 TypeScript 配置。
- CI：生产依赖审计、CodeQL 分析、Dependabot 更新、生成载荷一致性检查和仅在全部检查通过后运行的发布 job。
- 文档化 `main` 分支保护建议：必需检查为 `scheduler`、`pcs-issuer`、`host-runtime`、`secret-store`、`admin-app`、`payload`，禁止强制推送与删除。

### 变更

- 管理界面首次访问时跟随浏览器语言：中文浏览器用中文，其他语言一律用英文；已保存的选择仍然优先。
- 全仓库源码注释统一为英文。

### 修复

- 调度机与 PCS 的数据库测试按文件串行执行，避免跨文件 `TRUNCATE` 死锁。

## [4.5.0] - 2026-11-13

### 新增

- 侧载令牌与文件、主机控制和 Agent 控制资源。
- 任务暂停与恢复、自主程度、归类结果和失败分类。

## [4.4.0] - 2026-11-13

### 新增

- 动态调度：实时能力与需求、资源授予代次、持久化领取退避，以及调度算法文档。

## [4.3.1] - 2026-11-12

### 变更

- 双语文档和英文代码注释。运行时行为不变。

## [4.3.0] - 2026-11-12

### 新增

- 首个公开版本：PCS 控制面、host runtime、递归调度机、联邦、中继、构建机、Agent 适配层、管理应用、Compose 部署和验收工具。

[未发布]: https://github.com/UnmetDecade/OSACP/compare/v4.6.0...HEAD
[4.6.0]: https://github.com/UnmetDecade/OSACP/compare/v4.5.1...v4.6.0
[4.5.1]: https://github.com/UnmetDecade/OSACP/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/UnmetDecade/OSACP/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/UnmetDecade/OSACP/compare/v4.3.1...v4.4.0
[4.3.1]: https://github.com/UnmetDecade/OSACP/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/UnmetDecade/OSACP/releases/tag/v4.3.0
