const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexDesktop", {
  getSnapshot: () => ipcRenderer.invoke("stats:get"),
  refresh: () => ipcRenderer.invoke("stats:refresh"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  chooseCodexHome: () => ipcRenderer.invoke("config:choose-codex-home"),
  regenerateToken: () => ipcRenderer.invoke("config:regenerate-token"),
  getSystemInfo: () => ipcRenderer.invoke("system:get"),
});
