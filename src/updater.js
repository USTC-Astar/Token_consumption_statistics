const { EventEmitter } = require("events");

const DEFAULT_RELEASE_URL = "https://github.com/USTC-Astar/Token_consumption_statistics/releases/latest";

function updateErrorMessage(error) {
  const message = String(error?.message || error || "检查更新失败");
  // 仓库尚未发布首个 Release 时 GitHub 返回 404。对用户来说这是“暂无发布版”，不是程序故障。
  if (/404|Unable to find latest version on GitHub|No published versions on GitHub/i.test(message)) return "GitHub 尚未发布可用版本";
  if (/net::ERR_|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(message)) return "网络连接失败，请稍后重试";
  return message.replace(/^Error:\s*/i, "").slice(0, 240);
}

class UpdateController extends EventEmitter {
  constructor({ updater, appVersion, platform, isPackaged, isPortable = false, isAppImage = false, openExternal, releaseUrl = DEFAULT_RELEASE_URL }) {
    super();
    this.updater = updater;
    this.openExternal = openExternal;
    this.releaseUrl = releaseUrl;
    this.manualCheck = false;
    const platformSupported = ["win32", "darwin", "linux"].includes(platform);
    const installSupported = platform !== "linux" || isAppImage;
    this.state = {
      phase: isPackaged && platformSupported ? "idle" : "unsupported",
      currentVersion: appVersion,
      availableVersion: "",
      percent: 0,
      message: isPackaged ? "尚未检查更新" : "开发模式不检查更新",
      supported: Boolean(isPackaged && platformSupported),
      canAutoInstall: Boolean(isPackaged && platformSupported && installSupported && !isPortable),
      portable: Boolean(isPortable),
      releaseUrl,
      checkedAt: "",
    };
  }

  initialize() {
    if (!this.state.supported) return this.snapshot();
    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.allowPrerelease = false;
    this.updater.setFeedURL({ provider: "github", owner: "USTC-Astar", repo: "Token_consumption_statistics" });
    this.updater.on("checking-for-update", () => this.setState({ phase: "checking", message: "正在检查 GitHub Release…", percent: 0 }));
    this.updater.on("update-available", (info) => {
      const availableVersion = String(info?.version || "");
      const message = this.state.canAutoInstall
        ? `发现 ${availableVersion}，可下载并安装`
        : `发现 ${availableVersion}；当前免安装版请转到下载页安装主版本`;
      this.setState({ phase: "available", availableVersion, message, checkedAt: new Date().toISOString() });
    });
    this.updater.on("update-not-available", () => this.setState({
      phase: "up-to-date",
      message: `当前 ${this.state.currentVersion} 已是最新版本`,
      availableVersion: "",
      checkedAt: new Date().toISOString(),
    }));
    this.updater.on("download-progress", (progress) => this.setState({
      phase: "downloading",
      percent: Math.max(0, Math.min(100, Number(progress?.percent || 0))),
      message: `正在下载 ${Number(progress?.percent || 0).toFixed(1)}%`,
    }));
    this.updater.on("update-downloaded", (info) => this.setState({
      phase: "downloaded",
      availableVersion: String(info?.version || this.state.availableVersion || ""),
      percent: 100,
      message: "更新已下载，重启程序即可完成安装",
    }));
    this.updater.on("error", (error) => this.setState({
      phase: "error",
      message: updateErrorMessage(error),
      checkedAt: new Date().toISOString(),
    }));
    return this.snapshot();
  }

  snapshot() {
    return { ...this.state };
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit("status", this.snapshot());
    return this.snapshot();
  }

  async check({ manual = true } = {}) {
    this.manualCheck = manual;
    if (!this.state.supported) return this.snapshot();
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      // electron-updater 同时会触发 error 事件；这里仅保证某些 provider 直接 reject 时也能反馈状态。
      if (this.state.phase !== "error") this.setState({ phase: "error", message: updateErrorMessage(error), checkedAt: new Date().toISOString() });
    }
    return this.snapshot();
  }

  async download() {
    if (!this.state.canAutoInstall) {
      await this.openReleasePage();
      return this.setState({ message: "已打开主安装版下载页" });
    }
    try {
      this.setState({ phase: "downloading", percent: 0, message: "正在准备下载…" });
      await this.updater.downloadUpdate();
    } catch (error) {
      this.setState({ phase: "error", message: updateErrorMessage(error) });
    }
    return this.snapshot();
  }

  install() {
    if (this.state.phase !== "downloaded" || !this.state.canAutoInstall) return false;
    // 先让 IPC 返回，避免渲染进程在安装器接管前一直等待。
    setImmediate(() => this.updater.quitAndInstall(false, true));
    return true;
  }

  async openReleasePage() {
    await this.openExternal(this.releaseUrl);
    return true;
  }
}

module.exports = { UpdateController, updateErrorMessage, DEFAULT_RELEASE_URL };
