# 安全与隐私

## 数据处理范围

Codex 流量统计是本地优先应用。它读取用户明确配置的 `.codex` 目录，并在本机计算 Token、模型、项目、工具、日期和会话统计。

应用不会主动上传以下内容：

- Codex 登录凭据或 API 密钥。
- 用户提示词正文。
- 模型回复正文。
- `.codex/auth.json`。
- 工作区源代码。

## Tailscale 同步

启用设备同步后，对端会收到聚合统计和会话元数据。会话元数据可能包含：

- 会话标题。
- 项目名称和工作目录。
- 模型名称、日期、Token 和工具调用计数。

因此，同步功能只应在用户信任的 Tailnet 内使用。同步接口：

- 默认只绑定检测到的 Tailscale `100.x` 地址。
- 使用随机 Bearer Token 鉴权。
- 不应通过路由器端口映射、反向代理或公网隧道暴露到互联网。

访问令牌以明文形式保存在当前操作系统的 Electron 用户数据目录中。它的保护程度与当前系统账号的文件权限相同。

## 报告安全问题

请不要在公开 Issue 中提交真实 `.codex` 日志、访问令牌、项目路径或会话内容。创建 GitHub 仓库后，可通过仓库的 Security Advisory 私下报告安全问题。

报告中请包含：

- 受影响版本。
- 操作系统。
- 可复现步骤。
- 可能造成的影响。
- 已脱敏的日志或截图。

## Windows 代码签名

自动构建的 Windows EXE 默认没有商业代码签名证书。Microsoft Defender SmartScreen 可能显示“无法识别的应用”。下载者应从正式 GitHub Release 获取文件，并使用 Release 中的 SHA-256 校验文件核对完整性。

## macOS 签名与公证

自动构建的 macOS DMG 和 ZIP 默认没有 Apple Developer ID 签名，也没有经过 Apple 公证（Notarization）。Gatekeeper 首次打开时可能阻止应用运行。

下载者应只从正式 GitHub Release 获取文件，并使用同一 Release 中的 SHA-256 校验文件核对完整性。确认来源后，可在 Finder 中右键应用并选择“打开”；如果系统仍保留隔离标记，也可执行：

```bash
xattr -dr com.apple.quarantine "/Applications/Codex 流量统计.app"
```

该命令会移除指定应用的下载隔离标记，只应对已经核实来源和校验和的安装包使用。
