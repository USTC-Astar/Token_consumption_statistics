# 贡献指南

感谢参与 Codex 流量统计项目。

## 开发环境

- Node.js 22.12 或更高版本。
- npm 10 或更高版本。
- Windows 10/11、Electron 43 支持的 macOS，或主流 x64 Linux 桌面环境。

## 本地开发

```bash
npm ci
npm run check
npm start
```

## 提交修改前

```bash
npm run check
npm audit --audit-level=high
```

请确保：

- 不提交真实 `.codex` 日志、令牌、账号信息或本机配置。
- 新增关键流程时添加说明设计原因的中文注释。
- Windows、macOS 与 Linux 路径均使用 Node.js `path`/`os` API 处理。
- 不把同步端口默认绑定到公网网卡。
- README、CHANGELOG 和实际命令保持一致。

## Issue 与 Pull Request

- Bug 报告请提供操作系统、版本和脱敏复现步骤。
- 功能建议请说明使用场景，而不只是描述界面样式。
- Pull Request 应保持改动聚焦，避免顺带重构无关代码。
