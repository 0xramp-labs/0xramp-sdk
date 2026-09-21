# 0xramp example host — React Native (Expo)

Minimal RN host wiring the 0xramp pane into a `WebView`:

- `createSession` → load the returned `sessionUrl` (here: the sandbox pane);
- navigation locked to 0xramp origins via `onShouldStartLoadWithRequest`
  (RN WebView `postMessage` carries no origin — the navigation lock **is**
  the trust anchor);
- `attachPaneBridge` with a `PaneTransport` adapter over WebView messages;
- `onZecSendRequest` stubbed where your wallet core (e.g. zingolib) signs;
- attribution **"Powered by 0xramp · P2P.me"** rendered at the entry point.

```bash
# 1 — serve the sandbox pane (from the repo root):
npx serve sandbox -l 8081

# 2 — run the example:
npm install
npm start
```

Without configuration the pane loads the sandbox. Set `EXPO_PUBLIC_PARTNER_ID`
in your environment (or `.env`) and press **Start ramp** to call
`createSession` and load the returned session URL (validated against the
origin allowlist first — on iOS the initial `source` load bypasses
`onShouldStartLoadWithRequest`).

For pilots, implement the confirm/sign step against your wallet.

Known matrix gaps (RN WebView): passkeys and bank-app handoffs may require
the external-browser fallback path — see `docs/partner-guide.md`
(degradation ladder). Real-device behavior is a manual matrix item.
