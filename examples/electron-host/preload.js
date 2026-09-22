"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("pspElectron", {
  send: raw => ipcRenderer.send("psp:from-host-page", raw),
  ready: () => ipcRenderer.send("psp:host-loaded"),
  subscribe: handler => {
    const receive = (_event, value) => handler(value);
    ipcRenderer.on("psp:to-host-page", receive);
    return () => ipcRenderer.removeListener("psp:to-host-page", receive);
  },
});
