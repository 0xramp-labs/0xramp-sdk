# 0xramp example host — Electron

Minimal Electron host driving the **sandbox pane** end-to-end (PSP-v1), no
0xramp access and no real funds required.

```bash
npm install
npm start
```

Drive a real partner session instead of the sandbox (URL comes from
`createSession`; origin lock then enforces the pane origin):

```bash
PANE_URL="https://0xramp.app/partner/<partnerId>?sessionRef=…" npm start
```

What it demonstrates:

- hardened renderer (sandbox + context isolation, no Node in the pane);
- origin lock in the main process (`will-navigate`, `setWindowOpenHandler`);
- the host half of the bridge: validate → confirm → reply
  (`psp/zec-send-result` / `psp/zec-send-cancel`);
- attribution "Powered by 0xramp · P2P.me".

For real integrations use `attachPaneBridge` from `@0xramp/sdk` (typed
handlers, single-use requestId, fail-closed guarantees) — this example
mirrors the contract in vanilla JS so the protocol stays visible.
