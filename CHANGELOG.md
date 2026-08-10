# 更新日志

本项目遵循语义化版本（Semantic Versioning）。

## 2.2.0 - 2026-08-10

### 新增

- macOS Apple Silicon（ARM64）和 Intel（x64）桌面包。
- macOS DMG 安装包和 ZIP 便携压缩包。
- GitHub Actions macOS 双架构自动构建、校验和发布。
- macOS 本地网络访问用途说明，用于 Tailscale 多设备汇总。

### 改进

- CI 扩展到 Windows、macOS 和 Linux 三个平台。
- README 补充 macOS 安装、Gatekeeper 放行和源码构建说明。

## 2.1.0 - 2026-08-10

### 新增

- 今天、昨天快捷筛选。
- 今天与昨天逐项流量对比。
- 今日/昨日 24 小时流量图。
- 最近 14 天每日明细，包括零用量日期。
- 每 60 秒自动增量刷新。

### 改进

- Linux 与 Windows 双平台桌面包。
- Tailscale 多设备汇总与访问令牌鉴权。
- 增量 JSONL 日志缓存。
- 模型、项目、工具、峰值、会话和任务耗时统计。

## 2.0.0 - 2026-08-10

- 从 Python 本地网页迁移为 Electron 桌面应用。
- 增加 Windows/Linux 跨平台构建。
- 增加 Tailscale 设备同步。
