const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { scanCodexData } = require("./stats");
const { SyncServer } = require("./sync-server");

const execFileAsync = promisify(execFile);
let mainWindow;
let config;
let localStats;
let peerResults = [];
let refreshing = null;
let systemInfo = {};
const syncServer = new SyncServer(async () => localStats);

function configPath() {
  return path.join(app.getPath("userData"), "config.json");
}

function defaultConfig() {
  return {
    deviceId: crypto.randomUUID(),
    deviceName: os.hostname(),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    shareEnabled: true,
    sharePort: 18765,
    shareToken: crypto.randomBytes(24).toString("hex"),
    peers: [],
  };
}

function loadConfig() {
  try {
    return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), "utf8")) };
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
      codexHome: config.codexHome,
      cachePath,
      device: { id: config.deviceId, name: config.deviceName },
    });
    peerResults = await Promise.all(config.peers.filter((peer) => peer.enabled !== false).map(fetchPeer));
    return snapshot();
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function snapshot() {
  return {
    refreshing: Boolean(refreshing),
    local: localStats,
    peers: peerResults,
    system: systemInfo,
  };
}

function sanitizeConfig(input) {
  const next = { ...config, ...input };
  next.deviceName = String(next.deviceName || os.hostname()).trim().slice(0, 80);
  next.codexHome = String(next.codexHome || path.join(os.homedir(), ".codex"));
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
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 980,
    minWidth: 1100,
    minHeight: 720,
    title: "Codex 流量统计",
    backgroundColor: "#f4f6f1",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "static", "index.html"));
}

app.whenReady().then(async () => {
  config = loadConfig();
  saveConfig();
  registerIpc();
  await restartShareServer();
  createWindow();
  refreshStats().catch((error) => dialog.showErrorBox("读取 Codex 数据失败", error.message));
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => syncServer.stop());
