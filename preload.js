const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cinema", {
  startAll: () => ipcRenderer.invoke("start-all"),
  stopAll: () => ipcRenderer.invoke("stop-all"),
  status: () => ipcRenderer.invoke("status"),
  refreshIngress: () => ipcRenderer.invoke("refresh-ingress"),
  restartTunnel: () => ipcRenderer.invoke("restart-tunnel"),
  openUrl: url => ipcRenderer.invoke("open-url", url),
  copy: text => ipcRenderer.invoke("copy", text),
  minimize: () => ipcRenderer.invoke("window-minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window-toggle-maximize"),
  close: () => ipcRenderer.invoke("window-close"),
  getBroadcastInfo: () => ipcRenderer.invoke("get-broadcast-info"),
  getConfig: () => ipcRenderer.invoke("get-config"),
  saveConfig: cfg => ipcRenderer.invoke("save-config", cfg),

  onLog: callback => {
    ipcRenderer.on("log", (_, data) => callback(data));
  },

  onPublicUrl: callback => {
    ipcRenderer.on("public-url", (_, url) => callback(url));
  },

  onIngress: callback => {
    ipcRenderer.on("ingress", (_, data) => callback(data));
  },

  onStatus: callback => {
    ipcRenderer.on("status", async () => {
      callback(await ipcRenderer.invoke("status"));
    });
  }
});
