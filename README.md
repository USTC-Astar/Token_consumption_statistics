# Codex 流量统计

本地优先、跨 Windows、macOS 和 Linux 的 Codex Token 使用分析桌面应用。它读取电脑上的 `.codex` 会话日志，展示今天、昨天、每日趋势、模型、项目、工具、会话和流量峰值，并可通过 Tailscale 汇总多台电脑的数据。

> Local-first Codex token analytics desktop app for Windows, macOS and Linux, with optional multi-device aggregation over Tailscale.

## 适用对象

- 同时在 Windows、macOS 和 Linux 上使用 Codex 的个人用户。
- 希望了解每天 Token 用量、缓存比例和模型分布的用户。
- 希望比较不同项目、设备、时间段和会话消耗的用户。
- 不希望把原始 Codex 日志上传到第三方统计服务的用户。

## 主要功能

- **今日与昨日**：快捷筛选今天、昨天，并逐项比较输入、缓存、输出、推理、会话、轮次、工具和任务耗时。
- **每日明细**：最近 14 天逐日统计，没有使用 Codex 的日期也明确显示为 0。
- **流量拆分**：非缓存输入、缓存输入、模型输出和推理输出。
- **多维分类**：按设备、模型、项目、工具、小时和会话查看用量。
- **流量峰值**：汇总单日峰值、设备峰值、最大会话、最高流量时段和最高流量项目。
- **多设备汇总**：通过 Tailscale 连接 Windows、macOS 和 Linux 电脑，统一查看各设备和汇总数据。
- **增量扫描**：只有新增或变化的 JSONL 文件会被重新解析。
- **自动刷新**：应用打开后每 60 秒进行一次增量刷新。
- **本地优先**：不读取 API 密钥，不上传提示词正文或模型回复正文。

## 下载与安装

推荐从仓库右侧的 **Releases** 页面下载，不需要安装 Node.js。

### Windows 10/11 x64

下载：

```text
Codex-Traffic-Studio-<版本>-x64.exe
```

这是便携版程序，双击即可运行，不需要安装。当前自动构建版本没有商业代码签名，Microsoft Defender SmartScreen 可能显示“无法识别的应用”。请确认文件来自正式 Release，并使用同一 Release 中的 SHA-256 文件校验。

### Linux x64

下载：

```text
Codex-Traffic-Studio-<版本>-x86_64.AppImage
```

授予执行权限并运行：

```bash
chmod +x Codex-Traffic-Studio-*.AppImage
./Codex-Traffic-Studio-*.AppImage
```

正常结果：打开“Codex 流量统计”独立桌面窗口，并自动扫描当前用户的 `~/.codex`。

### macOS（Apple Silicon / Intel）

Apple Silicon（M1/M2/M3/M4 等 ARM64 芯片）下载：

```text
Codex-Traffic-Studio-<版本>-arm64.dmg
```

Intel 芯片下载：

```text
Codex-Traffic-Studio-<版本>-x64.dmg
```

打开 DMG 后，将“Codex 流量统计”拖入“应用程序”文件夹。首次打开时，因为公开构建没有 Apple Developer ID 签名和公证，macOS Gatekeeper 可能阻止运行。请先核对 Release 中的 SHA-256，然后在 Finder 中右键应用并选择“打开”。

如果右键打开后仍被阻止，可在终端执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Codex 流量统计.app"
```

该命令只应对已经确认来自本项目正式 GitHub Release 的应用使用。ZIP 文件提供相同应用的免 DMG 压缩版本。

## 数据目录

默认读取：

| 系统 | Codex 数据目录 |
| --- | --- |
| Linux | `~/.codex` |
| Windows | `%USERPROFILE%\.codex` |
| macOS | `~/.codex` |

如果 Codex 使用了其他目录，可在应用的“设备与同步”中手动选择 `.codex` 文件夹。

应用配置和增量缓存保存在 Electron 用户数据目录：

| 系统 | 应用配置目录 |
| --- | --- |
| Linux | `~/.config/codex-traffic-studio/` |
| Windows | `%APPDATA%\codex-traffic-studio\` |
| macOS | `~/Library/Application Support/codex-traffic-studio/` |

## 连接多台电脑

两台电脑使用相同的 OpenAI 账号或密钥，并不会自动合并本地日志。详细会话数据仍分别保存在各自的 `.codex` 目录中。

本应用的做法类似“每台电脑先计算自己的账单，再通过安全通道交换汇总结果”，而不是把两台电脑的原始日志复制到一起。

### 前提

- 两台电脑安装并登录 Tailscale。
- 两台电脑位于同一个可信 Tailnet。
- 两台电脑都打开 Codex 流量统计。

### 操作步骤

1. 在被统计的电脑上打开“设备与同步”。
2. 复制该电脑显示的 Tailscale 地址和本机访问令牌。
3. 在汇总电脑中点击“添加设备”。
4. 填写设备名称、Tailscale 地址和访问令牌。
5. 点击“保存并连接”。
6. 顶部“联网设备”显示新增设备后，即可选择“全部设备”或单独设备。

示例地址：

```text
http://<设备的-Tailscale-IP>:18765
```

同步接口默认只绑定检测到的 Tailscale `100.x` 地址，并使用随机 Bearer Token 鉴权。不要把端口 `18765` 映射到公网。

## 统计口径

- **输入 Token**：日志中的 `input_tokens`，包含缓存输入。
- **缓存输入**：日志中的 `cached_input_tokens`。
- **非缓存输入**：`input_tokens - cached_input_tokens`。
- **模型输出**：日志中的 `output_tokens`。
- **推理输出**：`reasoning_output_tokens`，单独展示但不重复加入总流量。
- **每日流量**：对会话累计 Token 做相邻差分后，按事件发生日期归集，避免重复统计。
- **任务耗时**：任务开始到任务完成/中止事件的时间差，可能包含命令执行、网络等待或用户确认时间。
- **会话日期**：按会话开始日期统计会话数量。

例如：某次日志累计值从 10,000 增长到 13,000，本应用只把新增的 3,000 Token 计入当前日期，而不是再次计入全部 13,000。

## 隐私与安全

应用不会主动上传：

- Codex API 密钥和登录凭据。
- 用户提示词正文。
- 模型回复正文。
- 工作区源代码。
- `.codex/auth.json`。

启用 Tailscale 同步时，会传输聚合统计和会话元数据。会话元数据可能包括会话标题、项目名称和工作目录。详细说明见 [SECURITY.md](SECURITY.md)。

## 从源码运行

### 环境要求

- Node.js 22.12 或更高版本。
- npm 10 或更高版本。
- Windows 10/11 x64、Electron 43 支持的 macOS，或主流 x64 Linux 桌面环境。

### 安装与启动

在项目根目录运行：

```bash
npm ci
npm run check
npm start
```

正常结果：

- `npm ci` 完成依赖安装。
- `npm run check` 不输出 JavaScript 语法错误。
- `npm start` 打开独立桌面窗口。

## 测试与安全检查

```bash
npm run check
npm audit --audit-level=high
```

项目目前以语法检查、真实日志解析验证、跨平台打包验证和依赖安全审计为主，尚未建立完整的自动化单元测试套件。

## 构建安装包

Electron 安装包建议在目标操作系统上构建。GitHub Actions 会分别使用 Windows、macOS 和 Linux Runner 自动构建。

### Linux AppImage

```bash
npm ci
npm run check
npm run dist:linux
```

输出目录：`dist/`。

### Windows 便携版

在 Windows PowerShell 中运行：

```powershell
npm ci
npm run check
npm run dist:win
```

输出目录：`dist`。

### macOS DMG 与 ZIP

在 macOS 终端中构建 Apple Silicon 版本：

```bash
npm ci
npm run check
npm run dist:mac -- --arm64
```

构建 Intel 版本：

```bash
npm run dist:mac -- --x64
```

输出目录：`dist/`。每个架构会生成一个 DMG 和一个 ZIP。macOS 安装包必须在 macOS 或 GitHub 的 macOS Runner 上构建，Linux 和 Windows 本机不能完成可用的 DMG 构建验证。

## 自动发布

仓库包含 GitHub Actions：

- `CI`：在 Windows、macOS 和 Linux 上对 Push 和 Pull Request 执行依赖安装、语法检查和高危漏洞审计。
- `Release`：推送 `v*` 标签后，构建 Windows EXE、Linux AppImage，以及 macOS ARM64/x64 的 DMG 和 ZIP，生成 SHA-256 并上传到 GitHub Release。

发布新版本前，先更新 `package.json` 和 `CHANGELOG.md`。例如发布 `2.2.0`：

```bash
npm version 2.2.0 --no-git-tag-version
npm run check
npm run verify:release -- v2.2.0
```

完成代码审查和提交后再创建并推送标签：

```bash
git tag v2.2.0
git push origin v2.2.0
```

## 项目结构

```text
.
├── build/                 # 应用图标
├── scripts/               # 图标和发布辅助脚本
├── src/
│   ├── main.js            # Electron 主进程、配置和远程设备连接
│   ├── preload.js         # 安全的渲染进程 API
│   ├── stats.js           # Codex JSONL 增量解析和统计
│   └── sync-server.js     # Tailscale 同步接口
├── static/                # 桌面界面和图表
├── .github/workflows/     # CI 与自动发布
├── CHANGELOG.md
├── CONTRIBUTING.md
├── SECURITY.md
└── package.json
```

## 开源方案调研与取舍

开发前调研了以下 MIT 开源项目：

- [CodeBurn](https://github.com/getagentseal/codeburn)：功能成熟，覆盖大量 AI 编程工具，但对轻量 Codex 中文应用而言范围和依赖较大。
- [Token Monitor](https://github.com/Javis603/token-monitor)：支持 Electron、多设备和多种 AI 工具。本项目采用了相似的本地扫描与设备同步方向，没有复制其源代码。
- [Codex Usage Desktop](https://github.com/itvincent-git/codex-usage-desktop)：专注 Codex 并采用 Tauri，但调研时未提供 Linux 安装包。
- [Codex Usage Tracker](https://github.com/douglasmonsky/codex-usage-tracker)：Python 分析能力丰富，但主要面向 CLI/MCP，而不是双击运行的跨平台桌面应用。

本项目保留自定义统计口径和中文界面，避免引入面向数十种工具的大型代码库。

## 已知限制

- Windows 自动构建版本未使用商业代码签名证书，可能触发 SmartScreen。
- macOS 自动构建版本未进行 Apple Developer ID 签名和公证，首次打开可能被 Gatekeeper 阻止。
- 远程电脑关机、应用关闭、Tailscale 离线或令牌错误时，只显示在线设备数据。
- 同步会包含会话标题和项目路径等元数据，使用前请阅读 [SECURITY.md](SECURITY.md)。
- 当前不提供价格/成本估算，因为不同套餐、模型和第三方提供商的计价方式可能造成误导。
- 当前只支持读取 Codex JSONL 会话日志，不统计其他 AI 编程工具。

## 贡献

请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。提交 Issue 时不要上传真实 Codex 日志、访问令牌或未脱敏截图。

## 许可证

本项目采用 [MIT License](LICENSE)。
