# 更新日志

> [English](CHANGELOG.md) · 简体中文

这里记录 OSACP 的重要变更。格式遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/)。

## [未发布]

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

[未发布]: https://github.com/UnmetDecade/OSACP/compare/v4.5.1...HEAD
[4.5.1]: https://github.com/UnmetDecade/OSACP/compare/v4.5.0...v4.5.1
[4.5.0]: https://github.com/UnmetDecade/OSACP/compare/v4.4.0...v4.5.0
[4.4.0]: https://github.com/UnmetDecade/OSACP/compare/v4.3.1...v4.4.0
[4.3.1]: https://github.com/UnmetDecade/OSACP/compare/v4.3.0...v4.3.1
[4.3.0]: https://github.com/UnmetDecade/OSACP/releases/tag/v4.3.0
