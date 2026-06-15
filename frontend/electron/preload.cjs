const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("cinchposSecureStorage", {
  get: (key) => ipcRenderer.invoke("cinchpos:secure-store:get", key),
  set: (key, value) => ipcRenderer.invoke("cinchpos:secure-store:set", key, value),
  remove: (key) => ipcRenderer.invoke("cinchpos:secure-store:remove", key)
});

contextBridge.exposeInMainWorld("cinchposDesktop", {
  getRuntimeConfig: () => ipcRenderer.invoke("cinchpos:get-runtime-config"),
  printHTML: (payload) => ipcRenderer.invoke("cinchpos:print-html", payload),
  updates: {
    getState: () => ipcRenderer.invoke("cinchpos:update:get-state"),
    check: () => ipcRenderer.invoke("cinchpos:update:check"),
    download: () => ipcRenderer.invoke("cinchpos:update:download"),
    install: () => ipcRenderer.invoke("cinchpos:update:install"),
    cancelDownload: () => ipcRenderer.invoke("cinchpos:update:cancel-download"),
    onStatus: (callback) => {
      if (typeof callback !== "function") {
        return () => {};
      }
      const listener = (_event, payload) => callback(payload);
      ipcRenderer.on("cinchpos:update-status", listener);
      return () => ipcRenderer.removeListener("cinchpos:update-status", listener);
    }
  }
});
