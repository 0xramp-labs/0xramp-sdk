# 0xramp example host — Electron

Minimal Electron host driving the **sandbox pane** end-to-end (PSP-v1), no
0xramp access and no real funds required.

Build the SDK at the repository root with `npm ci --ignore-scripts` and
`npm run build`. This example is opt-in and is not installed by SDK CI.
Use a locally approved Electron runtime to launch this directory. If installing
the example dependencies, use `npm install --ignore-scripts`; Electron's binary
setup requires a separate, explicit lifecycle-script decision by the owner.

`PANE_URL` overrides are refused. The fake wallet and memory journal are only
for local fixtures. They must never answer a live session. Hosted pages may
refuse iframes through CSP or X-Frame-Options; use a top-level pane for a live
desktop integration, without removing its security headers.

What it demonstrates:

- hardened renderer (sandbox + context isolation, no Node in the pane) — the
  top-level window is `host.html`, which iframes the pane;
- origin lock in the main process (`will-frame-navigate` covers the main
  frame **and** subframes, `setWindowOpenHandler` blocks popups);
- the actual SDK bridge in the main process: validate → journal → native
  sandbox confirmation → reply (result, cancel or pending);
- IPC sender validation for the exact host window, main frame and local URL;
- exact local file navigation, no live URLs, no raw envelope logging, and
  listener teardown when the window closes;
- attribution "Powered by 0xramp · P2P.me".

For a live desktop host, implement session creation/restoration, a durable
wallet-scoped journal, a real confirmation/signing adapter and ticketed status
reconciliation. See the [partner guide](../../docs/partner-guide.md). This
repository does not claim an Electron runtime or live desktop-wallet test.
