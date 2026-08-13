const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { execFile, execFileSync } = require("child_process");
const { promisify } = require("util");
const { scanCodexData, combineStatsData } = require("./stats");
const { SyncServer } = require("./sync-server");
const { UpdateController } = require("./updater");

const execFileAsync = promisify(execFile);
let mainWindow;
let config;
let localStats;
let peerResults = [];
let refreshing = null;
let systemInfo = {};
let updateController;
let updateTimer;
const syncServer = new SyncServer(async () => statsForSharing(localStats));

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function sourceId(sourcePath) {
  return `source-${crypto.createHash("sha256").update(sourcePath).digest("hex").slice(0, 12)}`;
}

function isWsl() {
  return process.platform === "linux" && (Boolean(process.env.WSL_DISTRO_NAME) || /microsoft/i.test(os.release()));
}

function runningWslDistributions() {
  if (process.platform !== "win32") return [];
  try {
    // wsl.exe 的列表输出通常是 UTF-16LE；保留 UTF-8 回退以兼容未来版本或非标准环境。
    const output = execFileSync("wsl.exe", ["--list", "--running", "--quiet"], {
      timeout: 3000,
      windowsHide: true,
    });
    const text = output.toString(output.includes(0) ? "utf16le" : "utf8").replaceAll("\0", "");
    return [...new Set(text.split(/\r?\n/).map((name) => name.replace(/^\uFEFF/, "").trim()).filter(Boolean))];
  } catch {
    // 没安装 WSL、没有正在运行的发行版或命令超时时，仍正常读取 Windows 本机目录。
    return [];
  }
}

function discoveredSources() {
  const rows = [];
  const add = (name, sourcePath) => {
    try {
      const resolved = path.resolve(sourcePath);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
      const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
      if (rows.some((row) => row.key === key)) return;
      rows.push({ id: sourceId(resolved), name, path: resolved, enabled: true, key });
    } catch {
      // Windows 系统用户目录可能不可访问；自动发现失败时跳过，用户仍可手动添加。
    }
  };

  add(isWsl() ? "WSL" : "本机", process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
  if (process.platform === "win32") {
    for (const distro of runningWslDistributions()) {
      const distroRoot = `\\\\wsl.localhost\\${distro}`;
      try {
        for (const entry of fs.readdirSync(path.join(distroRoot, "home"), { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          add(`WSL · ${distro} · ${entry.name}`, path.join(distroRoot, "home", entry.name, ".codex"));
        }
        add(`WSL · ${distro} · root`, path.join(distroRoot, "root", ".codex"));
      } catch {
        // 发行版可能正在关闭或文件共享暂时不可用；下次迁移或手动添加时仍可接入。
      }
    }
  }
  if (process.platform === "linux" && fs.existsSync("/mnt/c/Users")) {
    // WSL 可以直接读取 Windows 用户目录，因此默认把现有的 Windows .codex 一并纳入统计。
    try {
      for (const entry of fs.readdirSync("/mnt/c/Users", { withFileTypes: true })) {
        if (!entry.isDirectory() || ["All Users", "Default", "Default User", "Public"].includes(entry.name)) continue;
        add(`Windows · ${entry.name}`, path.join("/mnt/c/Users", entry.name, ".codex"));
      }
    } catch {
      // 某些 WSL 挂载策略不允许枚举 Windows 用户目录，此时保留手动添加能力。
    }
  }
  if (!rows.length) {
    const fallback = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    rows.push({ id: sourceId(fallback), name: "本机", path: fallback, enabled: true, key: fallback });
  }
  return rows.map(({ key, ...row }) => row);
}

function defaultConfig() {
  return {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    sources: discoveredSources(),
    shareEnabled: true,
    sharePort: 18765,
    shareToken: crypto.randomBytes(24).toString("hex"),
    peers: [],
  };
}

function loadConfig() {
  try {
    const defaults = defaultConfig();
    const saved = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    const next = { ...defaults, ...saved };
    if (!Array.isArray(saved.sources) || !saved.sources.length) {
      // 2.x 版本只保存一个 codexHome。迁移时保留该目录，同时补充自动发现的 Windows/WSL 数据源。
      const legacyPath = path.resolve(saved.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
      const discovered = discoveredSources();
      const legacy = { id: sourceId(legacyPath), name: discovered.find((source) => source.path === legacyPath)?.name || "本机", path: legacyPath, enabled: true };
      next.sources = [legacy, ...discovered.filter((source) => source.path !== legacyPath)];
    }
    if (isWsl()) {
      const linuxHome = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
      next.sources = next.sources.map((source) => source.path === linuxHome && source.name === "本机" ? { ...source, name: "WSL" } : source);
    }
    delete next.codexHome;
    return sanitizeConfig(next);
  } catch {
    return defaultConfig();
  }
}

function saveConfig() {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), "utf8");
}

function isTailscaleIPv4(address) {
  const parts = String(address).split(".").map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

async function detectSystemInfo() {
  const interfaces = os.networkInterfaces();
  const candidates = Object.entries(interfaces).flatMap(([name, values]) =>
    (values || []).filter((item) => item.family === "IPv4" && !item.internal).map((item) => ({ name, address: item.address }))
  );
  const tailscale = candidates.find((item) => /tailscale/i.test(item.name)) || candidates.find((item) => isTailscaleIPv4(item.address));
  let dnsName = "";
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], { timeout: 4000, windowsHide: true });
    dnsName = JSON.parse(stdout)?.Self?.DNSName?.replace(/\.$/, "") || "";
  } catch {
    // Windows 或 macOS 可能仅安装 GUI 版 Tailscale，找不到 CLI 时仍可使用检测到的 100.x 地址。
  }
  systemInfo = {
    platform: process.platform,
    hostname: os.hostname(),
    tailscaleIp: tailscale?.address || "",
    tailscaleDns: dnsName,
    shareAddress: syncServer.address,
  };
  return systemInfo;
}

function normalizePeerUrl(address) {
  let value = String(address || "").trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  const url = new URL(value);
  if (!url.port) url.port = "18765";
  url.pathname = "/api/v1/stats";
  url.search = "";
  return url;
}

function fetchJson(url, token) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 8000,
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch { reject(new Error("返回内容不是有效 JSON")); }
      });
    });
    request.on("timeout", () => request.destroy(new Error("连接超时")));
    request.on("error", reject);
  });
}

function statsForSharing(stats) {
  if (!stats) return stats;
  const sanitizeData = (data) => ({
    ...data,
    codexHome: "",
    source: data.source ? { ...data.source, path: "" } : data.source,
    sessions: (data.sessions || []).map(({ sourcePath, ...session }) => session),
  });
  return {
    ...sanitizeData(stats),
    sources: (stats.sources || []).map((source) => ({
      id: source.id,
      name: source.name,
      enabled: source.enabled,
      available: source.available,
      data: sanitizeData(source.data),
    })),
  };
}

async function fetchPeer(peer) {
  const started = Date.now();
  try {
    const payload = await fetchJson(normalizePeerUrl(peer.address), peer.token);
    if (!payload.data) throw new Error("对端没有统计数据");
    return {
      id: peer.id,
      name: peer.name || payload.data.device?.name || peer.address,
      address: peer.address,
      online: true,
      latencyMs: Date.now() - started,
      data: payload.data,
    };
  } catch (error) {
    return { id: peer.id, name: peer.name || peer.address, address: peer.address, online: false, error: error.message };
  }
}

async function restartShareServer() {
  await detectSystemInfo();
  const host = config.shareEnabled ? systemInfo.tailscaleIp : "";
  let shareError = "";
  try {
    await syncServer.start({ host, port: Number(config.sharePort), token: config.shareToken });
  } catch (error) {
    shareError = error.message;
  }
  await detectSystemInfo();
  systemInfo.shareError = shareError;
}

async function refreshStats() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const cachePath = path.join(app.getPath("userData"), "scan-cache.json");
    localStats = await scanCodexData({
      sources: config.sources,
      cachePath,
      device: { id: config.deviceId, name: config.deviceName },
    });
    peerResults = await Promise.all(config.peers.filter((peer) => peer.enabled !== false).map(fetchPeer));
    return snapshot();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function snapshot() {
  const onlinePeerData = peerResults.filter((peer) => peer.online && peer.data).map((peer) => peer.data);
  const aggregate = localStats ? combineStatsData([localStats, ...onlinePeerData], { dedupeMode: "exact" }) : null;
  return {
    refreshing: Boolean(refreshing),
    local: localStats,
    peers: peerResults,
    aggregate,
    system: systemInfo,
  };
}

function sanitizeConfig(input) {
  const next = { ...config, ...input };
  next.deviceName = String(next.deviceName || os.hostname()).trim().slice(0, 80);
  const seenPaths = new Set();
  next.sources = (Array.isArray(next.sources) ? next.sources : discoveredSources()).map((source, index) => {
    const rawPath = String(source.path || "").trim();
    if (!rawPath) return null;
    const sourcePath = path.resolve(rawPath);
    const pathKey = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
    if (!sourcePath || seenPaths.has(pathKey)) return null;
    seenPaths.add(pathKey);
    return {
      id: String(source.id || sourceId(sourcePath)),
      name: String(source.name || `数据源 ${index + 1}`).trim().slice(0, 80),
      path: sourcePath,
      enabled: source.enabled !== false,
    };
  }).filter(Boolean);
  if (!next.sources.length) {
    const fallback = path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    next.sources = [{ id: sourceId(fallback), name: "本机", path: fallback, enabled: true }];
  }
  next.sharePort = Math.min(65535, Math.max(1024, Number(next.sharePort) || 18765));
  next.peers = Array.isArray(next.peers) ? next.peers.map((peer) => ({
    id: peer.id || crypto.randomUUID(),
    name: String(peer.name || "远程设备").trim().slice(0, 80),
    address: String(peer.address || "").trim(),
    token: String(peer.token || "").trim(),
    enabled: peer.enabled !== false,
  })).filter((peer) => peer.address && peer.token) : [];
  return next;
}

function registerIpc() {
  ipcMain.handle("stats:get", async () => localStats ? snapshot() : refreshStats());
  ipcMain.handle("stats:refresh", refreshStats);
  ipcMain.handle("config:get", () => config);
  ipcMain.handle("system:get", detectSystemInfo);
  ipcMain.handle("updates:get", () => updateController.snapshot());
  ipcMain.handle("updates:check", () => updateController.check({ manual: true }));
  ipcMain.handle("updates:download", () => updateController.download());
  ipcMain.handle("updates:install", () => updateController.install());
  ipcMain.handle("updates:open-release", () => updateController.openReleasePage());
  ipcMain.handle("config:choose-codex-home", async () => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"], title: "选择 Codex 数据目录（.codex）" });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("config:regenerate-token", async () => {
    config.shareToken = crypto.randomBytes(24).toString("hex");
    saveConfig();
    await restartShareServer();
    return config.shareToken;
  });
  ipcMain.handle("config:save", async (_event, input) => {
    config = sanitizeConfig(input);
    saveConfig();
    await restartShareServer();
    await refreshStats();
    return { config, snapshot: snapshot() };
  });
}

function createWindow() {
  const windowIcon = path.join(__dirname, "..", "build", process.platform === "win32" ? "icon.ico" : "icon.png");
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: "Codex 流量统计",
    backgroundColor: "#f4f6f1",
    autoHideMenuBar: true,
    icon: windowIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  if (process.env.CODEX_TRAFFIC_VERIFY_UI === "1") {
    mainWindow.webContents.on("did-finish-load", () => mainWindow.webContents.executeJavaScript(`
      window.__verificationErrors = [];
      window.addEventListener("error", (event) => window.__verificationErrors.push(event.message));
      window.addEventListener("unhandledrejection", (event) => window.__verificationErrors.push(String(event.reason)));
    `));
  }
  mainWindow.loadFile(path.join(__dirname, "..", "static", "index.html"));
}

app.whenReady().then(async () => {
  config = loadConfig();
  saveConfig();
  updateController = new UpdateController({
    updater: autoUpdater,
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    isPortable: Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
    isAppImage: Boolean(process.env.APPIMAGE),
    openExternal: (url) => shell.openExternal(url),
  });
  updateController.initialize();
  updateController.on("status", (status) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("updates:status", status);
  });
  registerIpc();
  await restartShareServer();
  createWindow();
  refreshStats().catch((error) => dialog.showErrorBox("读取 Codex 数据失败", error.message));
  // 启动后稍作延迟再检查，避免网络请求与首次日志扫描争抢磁盘和界面启动时间。
  if (updateController.snapshot().supported) {
    setTimeout(() => updateController.check({ manual: false }), 3000);
    updateTimer = setInterval(() => updateController.check({ manual: false }), 6 * 60 * 60 * 1000);
    updateTimer.unref?.();
  }
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (updateTimer) clearInterval(updateTimer);
  syncServer.stop();
});

module.exports = { getMainWindow: () => mainWindow, statsForSharing };
