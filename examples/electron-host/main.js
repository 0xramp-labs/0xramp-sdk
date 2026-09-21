"use strict";

/**
 * Minimal Electron host for the 0xramp pane (PSP-v1, host half).
 *
 * Architecture: host.html (renderer, sandboxed, no Node) iframes the pane.
 * The pane posts PSP envelopes to window.parent; host.html validates them,
 * asks the user to confirm ZEC sends, and answers into the iframe. The main
 * process enforces the origin lock for all navigation.
 *
 * Default pane: ../../sandbox/sandbox-pane.html — no 0xramp access needed.
 * Run with PANE_URL=https://0xramp.app/... to drive a real partner session
 * URL (issued by createSession). Origin lock then applies to that origin.
 *
 * This example mirrors the bridge contract in vanilla JS for readability.
 * Real integrations should use `attachPaneBridge` from @0xramp/sdk: same
 * rules, typed handlers, stats, and fail-closed guarantees.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const PANE_URL = process.env.PANE_URL || "";
const SANDBOX_URL = "file://" + path.join(__dirname, "..", "..", "sandbox", "sandbox-pane.html");
const START_URL = PANE_URL || SANDBOX_URL;

// Origin lock — src/bridge/origin.ts is the authoritative allowlist source.
const ALLOWED_HOST_SUFFIXES = ["0xramp.app"];

function isAllowedNavigation(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:" && !PANE_URL) return true; // sandbox pane only
    if (parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return ALLOWED_HOST_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
  } catch {
    return false;
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 760,
    webPreferences: {
      // Hardened renderer: sandboxed, isolated context, no Node in the pane.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  // One-way visibility: log pane envelopes in the main-process console.
  ipcMain.on("psp:from-host-page", (_event, raw) => {
    console.log("[bridge] pane →", JSON.stringify(raw));
  });

  win.webContents.on("will-navigate", (event, url) => {
    if (!isAllowedNavigation(url)) {
      console.warn("[origin-lock] blocked navigation:", url);
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    console.warn("[origin-lock] blocked popup:", url);
    return { action: "deny" };
  });

  win.loadURL(START_URL);
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
