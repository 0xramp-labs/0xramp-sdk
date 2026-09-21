"use strict";

const { contextBridge, ipcRenderer } = require("electron");

// One-way logging channel: pane envelopes reach the main-process console.
// (The reply path runs in the host page — see host.html.)
contextBridge.exposeInMainWorld("pspElectron", {
  sendToHost: (raw) => ipcRenderer.send("psp:from-host-page", raw),
});
