"use strict";
// Local sandbox only. Live partner pages require a top-level hosted pane,
// durable wallet storage and a native wallet adapter; see the partner guide.
const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

if (process.env.PANE_URL) throw new Error("PANE_URL is not supported: this example is sandbox-only");
const hostUrl = pathToFileURL(path.join(__dirname, "host.html")).href;
const sandboxUrl = pathToFileURL(path.join(__dirname, "../../sandbox/sandbox-pane.html")).href;
let sequence = 0;

async function createWindow() {
  const { attachPaneBridge, createMemoryZecSendStore } = await import("../../dist/index.js");
  const sessionRef = `sessSANDBOX${Date.now()}_${++sequence}`;
  const paneUrl = `${sandboxUrl}?sessionRef=${sessionRef}`;
  const win = new BrowserWindow({ width: 900, height: 760, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
    preload: path.join(__dirname, "preload.js"),
  } });
  function trusted(event) {
    return event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === hostUrl;
  }
  function send(kind, value) { if (!win.isDestroyed()) win.webContents.send("psp:to-host-page", { kind, value }); }
  const transport = {
    post: message => send("reply", message),
    subscribe: handler => {
      const receive = (event, raw) => { if (trusted(event)) handler(raw); };
      ipcMain.on("psp:from-host-page", receive);
      return () => ipcMain.removeListener("psp:from-host-page", receive);
    },
  };
  const bridge = attachPaneBridge({ sessionRef, transport, sendStore: createMemoryZecSendStore(), handlers: {
    onReady: () => send("status", "Sandbox ready — no real money"),
    onZecSendRequest: async (_request, { signal }) => {
      if (signal.aborted) return { cancel: true, reason: "simulation closed" };
      const answer = await dialog.showMessageBox(win, { type: "question", title: "Sandbox send", message: "Simulate a ZEC send? No funds move.", buttons: ["Cancel", "Simulate"], defaultId: 0, cancelId: 0 });
      return answer.response === 1 && !signal.aborted ? { txid: "e".repeat(64) } : { cancel: true, reason: "simulation declined" };
    },
    onResult: () => send("status", "Simulated advisory result; no real settlement"),
    onClose: () => { if (!win.isDestroyed()) win.close(); },
    onProtocolError: () => { bridge.close(); send("closed", "Bridge refused a message. Reopen the example to start again."); },
  } });
  const loaded = event => { if (trusted(event)) send("open", paneUrl); };
  ipcMain.on("psp:host-loaded", loaded);
  win.webContents.on("will-frame-navigate", details => {
    // Only this exact local host and this session's exact fixture may load.
    if (details.url !== hostUrl && details.url !== paneUrl) details.preventDefault();
  });
  win.webContents.on("will-redirect", (event, url) => { if (url !== hostUrl && url !== paneUrl) event.preventDefault(); });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.on("closed", () => { bridge.close(); ipcMain.removeListener("psp:host-loaded", loaded); });
  await win.loadURL(hostUrl);
}

app.whenReady().then(() => {
  void createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
