# Partner guide — hosting the 0xramp pane

A practical walkthrough for integrating `@0xramp/sdk` in a wallet app
(React Native and Electron recipes). Read [`SPEC.md`](./SPEC.md) for the
surface contract and [`DESIGN.md`](./DESIGN.md) for the trust model.

## 0. Onboarding

1. Request a `partnerId` from 0xramp (public identifier, safe to ship).
2. Agree your pilot corridors (e.g. SELL ZEC→BRL via Pix) and a staging
   `apiBaseUrl` (issued by 0xramp; production is built in).
3. Register a return deep-link scheme for your app (e.g. `mywallet://ramp`).

## 1. Create a session (channel 1)

```ts
const ramp = createRampClient({
  environment: "production",
  partnerId: "your-partner-id",
  locale: "pt",
});

const session = await ramp.createSession({
  direction: "sell",           // "sell" | "buy"
  asset: "ZEC",
  fiat: "BRL",
  returnUrl: "mywallet://ramp",
});
// → { sessionUrl, sessionRef, statusTicket, expiresAt }
```

`sessionRef + statusTicket` are a **read-only, bearer-ish pair**: treat them
as sensitive, never log them raw (the SDK already redacts).

## 2. Host the pane (channel 2) — origin lock is mandatory

Load `sessionUrl` in a WebView and lock **all** navigation to `0xramp.app`
origins (https, subdomains allowed). Never hide or rebrand the origin.

### React Native recipe

```tsx
import { WebView } from "react-native-webview";
import {
  assertAllowedPaneNavigation,
  isAllowedPaneNavigation,
  ALLOWED_PANE_HOST_SUFFIXES,
} from "@0xramp/sdk";

// iOS: the initial `source` load never reaches onShouldStartLoadWithRequest,
// so validate the session URL yourself before handing it to the WebView.
assertAllowedPaneNavigation(session.sessionUrl);

<WebView
  source={{ uri: session.sessionUrl }}
  onShouldStartLoadWithRequest={(req) =>
    isAllowedPaneNavigation(req.url, ALLOWED_PANE_HOST_SUFFIXES)
  }
  originWhitelist={["https://0xramp.app", "https://*.0xramp.app"]}
  onMessage={onMessage}
/>;
```

- RN `postMessage` carries **no origin** — the navigation lock is your trust
  anchor. Enforce it for every request, including frames and redirects.
- **iOS gap:** `onShouldStartLoadWithRequest` is **not** called for the
  initial `source` load — always run
  `assertAllowedPaneNavigation(session.sessionUrl)` before rendering the
  WebView (the SDK's `createSession` already refuses non-allowlisted URLs,
  so this is defense in depth).
- Known gaps: passkeys and bank-app handoffs can misbehave inside WebViews.
  The pane detects this and deep-links out to the system browser (ladder,
  below) — keep `returnUrl` registered and handle its resume.

### Electron recipe

```js
win.webContents.on("will-navigate", (event, url) => {
  if (!isAllowedPaneNavigation(url)) event.preventDefault();
});
win.webContents.setWindowOpenHandler(({ url }) => ({ action: "deny" }));
```

Use a hardened renderer: `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`. Relay envelopes over IPC; never let the pane touch
Node. See `examples/electron-host/`.

## 3. Wire the bridge (channel 3) — the pane drives

```ts
const pane = ramp.attachPaneBridge({
  transport, // postMessage/IPC adapter — examples show RN + Electron
  onZecSendRequest: async ({ requestId, address, amountZat }) => {
    // SELL only. This is the ONE signature your app ever makes.
    // 1. confirm with the user in YOUR native UI (show address + amountZat)
    // 2. sign with YOUR wallet core (e.g. zingolib), broadcast
    // 3. return the txid — or { cancel: true, reason }
    const txid = await wallet.sendToTransparent(address, amountZat);
    return { txid };
  },
  onResult: (r) => showReceipt(r),   // advisory
  onClose: () => teardownPane(),
});
```

The SDK enforces: schema validation before dispatch, single-use `requestId`,
strict `sessionRef` matching, fail-closed on unknown envelope versions.
Respond to every `zec-send-request` exactly once (result or cancel).

## 4. Status and receipts (channel 4)

```ts
const status = await ramp.getStatus(session.sessionRef);
// { outcome, terminal, zecTxids?, fiat?, updatedAt }
```

This ticketed endpoint is the **authoritative** partner-visible signal.
Poll it (respect `expiresAt`), or check it when a `psp/result` or return
deep-link arrives. Fiat `amountDisplay` is a receipt string — never parse it
for math.

## 5. Return deep-links (channel 5)

When the pane finishes, it navigates to your `returnUrl` with
`sessionRef` + `outcome` query params. **This is advisory UX resume only —
spoofable by design** (any app can open your scheme). Parse with
`ramp.parseReturnUrl(url)`, then always reconcile via `getStatus` and your
own Zcash chain view before anything irreversible.

## Degradation ladder (all rungs are first-class)

1. **Full WebView** — passkey, bank app, QR all work in-pane.
2. **Auth/payment handoff** — pane deep-links to the system browser for a
   step, session continues there, returns via `returnUrl`. Keep it working.
3. **Bridge dead** — pane shows the deposit address + exact amount (QR/copy);
   the user pastes a send into your wallet manually. Your app still finishes
   the session via status polling.
4. **Origin drift** — hard abort. Never hide the origin, never wrap it.

## Attribution (required)

Render **"Powered by 0xramp · P2P.me"** visibly at the ramp entry point
(header/footer of the pane screen). It is a term of use, not a nicety.

## Integration checklist

- [ ] `createSession` on your ramp entry; errors surfaced (quota, network).
- [ ] WebView navigation locked to `0xramp.app` origins on every request.
- [ ] `onZecSendRequest` → native confirm → wallet sign → txid (or cancel).
- [ ] Every send request answered exactly once.
- [ ] `getStatus` polled/shown; `psp/result` treated as advisory.
- [ ] `returnUrl` registered + parsed; reconciliation never trusts it.
- [ ] Attribution rendered.
- [ ] Tested against `sandbox/sandbox-pane.html` (and the golden fixtures).
- [ ] Degradation ladder exercised: external-browser handoff, paste-to-send.
