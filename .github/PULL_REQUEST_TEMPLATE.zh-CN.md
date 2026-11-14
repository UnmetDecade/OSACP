## 改了什么

<!-- 一段话说明。关联本 PR 关闭的 issue。 -->

Closes #

## 为什么

<!-- 要解决的问题，以及你选择的取舍。 -->

## 验证

- [ ] 所有受影响的后端包都通过 `npm run typecheck` 和 `npm test`
- [ ] 涉及管理界面时，`admin-app` 通过 `npm run lint && npm test && npm run build`
- [ ] 已运行 `node scripts/build-app-payload.mjs`，`deploy/*/app` 没有意外差异
- [ ] 新行为有测试；界面变更附截图或 GIF
- [ ] 行为变更时，英文文档和 `.zh-CN.md` 都已更新

## 风险

- [ ] 没有协议、数据库结构、认证或信任模型变更
- [ ] 安全与兼容性影响写在下面

<!-- 说明迁移、上线或回滚要求。 -->
