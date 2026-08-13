const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexDesktop", {
  getSnapshot: () => ipcRenderer.invoke("stats:get"),
  refresh: () => ipcRenderer.invoke("stats:refresh"),
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveConfig: (config) => ipcRenderer.invoke("config:save", config),
  chooseCodexHome: () => ipcRenderer.invoke("config:choose-codex-home"),
  regenerateToken: () => ipcRenderer.invoke("config:regenerate-token"),
  getSystemInfo: () => ipcRenderer.invoke("system:get"),
  getUpdateStatus: () => ipcRenderer.invoke("updates:get"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  openReleasePage: () => ipcRenderer.invoke("updates:open-release"),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
});
