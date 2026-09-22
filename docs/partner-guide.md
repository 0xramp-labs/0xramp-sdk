# Partner guide — hosting the 0xramp pane

For an API deployment that explicitly supports idempotent creation, generate
32 cryptographically random bytes, encode them as base64url and securely persist
that `idempotencyKey` together with the complete `createSession` input **before**
sending. The SDK carries it in `Idempotency-Key`; it never retries automatically.
An explicit recovery must reuse the identical key and body; changing the input
must fail with 409. `partnerSessionId` is public correlation data and cannot
recover credentials. Do not assume that sending a header adds this guarantee to
an older server. The native example remains conservative and requires manual
reconciliation after a lost create response.

Use the SDK for a **SELL ZEC → fiat host-mode pilot** first. The SDK opens a
hosted session, connects a wallet callback and reads status. It does not
implement a fiat provider, a wallet signer or QR-PAY. BUY currently requires
a transparent receiving address. See [pilot gates](partner-readiness.md),
[the public protocol](SPEC.md) and [the architecture](DESIGN.md).

## 1. Onboarding and exact origins

Obtain a public `partnerId`, an enabled corridor, the partner API origin and
the exact pane origins from 0xramp. Confirm the create/status routes and
the hosted pane support this revision of PSP-v1, including `zec-send-pending`.
A reachable homepage or successful OPTIONS request does not prove that.

```ts
const ramp = createRampClient({
  environment: "staging",
  partnerId: "your-issued-partner-id",
  apiBaseUrl: "https://api.pilot.example", // replace with issued origin
  paneOrigins: ["https://pane.pilot.example"], // exact, explicitly issued
  sendStore,
  requestTimeoutMs: 15_000,
});
```

Custom API deployments default to their **exact origin**, not their parent
hosting domain. If API and pane origins differ, supply `paneOrigins`.
Production without overrides allows HTTPS `0xramp.app` and its subdomains;
partners can narrow this with `paneOrigins: ["https://0xramp.app"]`.
Credentials embedded in URLs are refused. Redirects from ticketed API
requests are refused; injected fetch implementations must honor that policy
and `AbortSignal`. Validate the native fetch implementation in your device
matrix; use a redirect-refusing adapter if it does not honor `redirect: "error"`.

## 2. Durable wallet-scoped send journal

Any bridge with `onZecSendRequest` requires a `sendStore`. Persist it in the
wallet's secure storage. Do not use a new memory store on every WebView load.

```ts
import { createZecSendStore } from "@0xramp/sdk";

// One shared adapter/store for one unlocked wallet namespace.
const sendStore = createZecSendStore({
  get: key => secureWalletStorage.get(key),
  set: (key, value) => secureWalletStorage.set(key, value),
});
```

The journal records an unresolved claim **before** invoking the wallet.
It binds `(sessionRef, requestId)` to address, amount and memo. It stores an
outcome before sending the reply. On a new bridge or app restart, a known
outcome is replayed; an unresolved claim stays pending and never invokes
the wallet again automatically. Reusing an ID with different payment data
is refused. Final results/cancellations cannot be overwritten.

`createZecSendStore` serializes operations sharing the same storage adapter
object in one JavaScript process. Separate adapter objects, multiple
processes, extensions or devices require an implementation of `ZecSendStore`
with an atomic durable `claim` transaction. Do not assume key/value storage
alone provides cross-process exactly-once execution. Wallet-side recovery
must use the same request identity. Never erase an unresolved record to retry.

Secure storage failures block signing. A failure after broadcast stays
pending, retaining known transaction IDs when possible. Secure storage has
platform-specific size/backup limits; test them and reconcile wallet history
after storage loss or restoration. `createMemoryZecSendStore` is only for
tests and the isolated sandbox.

## 3. Create, save, attach, then load

```ts
// Persist creation intent first. The correlation ID is NOT an idempotency key.
await sessionStorage.saveCreationIntent(partnerSessionId);
const session = await ramp.createSession({
  direction: "sell", asset: "ZEC", fiat: "BRL",
  returnUrl: "mywallet://ramp", partnerSessionId,
});
await sessionStorage.save(session);

const bridge = ramp.attachPaneBridge({
  sessionRef: session.sessionRef,
  transport,
  onZecSendRequest: async (request, { signal }) => {
    // Implement in the wallet: user confirmation, balance + network fee,
    // exact zatoshi/string amount, transparent destination, wallet history.
    return wallet.confirmAndSend(request, { signal });
  },
  onResult: () => { void refreshAuthoritativeStatus(); },
  onSendRecoveryRequired: () => showRecoveryScreen(),
  onClose: () => teardownPane(),
});
if (!ramp.isAllowedPaneUrl(session.sessionUrl)) throw new Error("origin refused");
loadWebView(session.sessionUrl);
```

Close the old bridge before switching sessions and on component unmount.
Attach a fresh bridge **before** loading each pane, explicitly bound to the
session. `psp/close` detaches its listener before calling your close handler.
`close()` signals pending wallet confirmation via `AbortSignal`; your adapter
must check it before signing. It cannot undo a broadcast already started.
An outcome arriving after closure is still journaled for recovery.

API requests have a bounded deadline, including the response body, and no
automatic retries. A lost create response may follow successful server-side
creation: keep its persisted intent and reconcile with 0xramp before another
POST. `partnerSessionId` is correlation only; server-side idempotency or a
recovery lookup must be agreed during onboarding. Do not silently fall back
to the sandbox after a live error.

### React Native transport and navigation

Host → pane: `webViewRef.postMessage(JSON.stringify(envelope))`.
Pane → host: `window.ReactNativeWebView.postMessage(JSON.stringify(envelope))`.
The sandbox receives string messages on both `window` and `document`, which
accommodates the iOS and Android delivery targets, and deduplicates the same
event. Browser iframe transport still uses `window.parent.postMessage`.

Use `ramp.isAllowedPaneUrl` for the initial source **and every navigation**.
Initial loads can bypass `onShouldStartLoadWithRequest` (documented on Android). Native bridge
messages alone do not authenticate an origin; keep the navigation invariant
and validate the WebView event URL. Display the actual pane origin, not its
full ticket-bearing URL. Configure popup, file and mixed-content policies.

The [RN example](../examples/react-native-host/) uses secure storage,
foreground/deep-link status checks and explicit close/resume. Its live wallet
adapter refuses sends until you implement it. Its fake transaction IDs exist
only in a loopback sandbox. It registers `ramp-example://ramp` for development
builds. A partner must register and route its own scheme; do not assume a
wallet already supports `zingo://ramp`.

### Electron boundary

The [Electron example](../examples/electron-host/) is deliberately a **local
sandbox demo**. It calls the real SDK in the main process and verifies the
IPC sender window, frame and URL. It refuses live `PANE_URL` overrides.

For a live host, use a **top-level** pane surface with a visible origin:
server `frame-ancestors` / X-Frame-Options may forbid iframes. Do not strip
those headers. Keep `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`; expose only a narrow preload channel, validate every
IPC sender and enforce `ramp.isAllowedPaneUrl` on initial loads, navigations,
redirects and popups. A live desktop wallet adapter and durable journal are
partner work; the sandbox is not a production desktop host.

## 4. Wallet results and uncertain sends

| Wallet callback outcome | Bridge reply |
|---|---|
| `{ txid }` | Result: this is the identified deposit transaction |
| `{ txid, txids }` | Result plus all related transaction IDs; `txids` must contain `txid` |
| `{ txids: [oneTxid] }` | Result for the single transaction |
| `{ txids: [first, second] }` | Pending: multiple transactions require reconciliation |
| `{ cancel: true, reason }` | Cancel, only when no broadcast occurred |
| `{ pending: true, txids? }`, thrown error or invalid output | Pending, never an inferred cancellation |

Zcash wallet APIs can return several transaction IDs (for example preparation
plus payment). Preserve them as an array. Do not join them into one string or
guess that the first/last ID paid the deposit. Identify the deposit transaction
from wallet history and its outputs, or stay pending. Validate the exact
amount, destination and fees using integer arithmetic in your native adapter.

Pending means **reconcile; do not send again**, including after timeout,
closure or app restart. Once wallet history proves the deposit transaction,
`await bridge.sendZecSendResult(requestId, verifiedTxid)` records it; call
`await bridge.sendZecSendCancel(requestId, reason)` only after proving no
broadcast. These methods apply to a request accepted by that bridge and reject
persistence failures. A custom recovery screen can also complete a previously
claimed record through its `ZecSendStore` before reopening the bridge.

The pane must keep the same request ID across reconnects for the same payment
intent. Generating a fresh ID to evade an unresolved claim defeats recovery
and is forbidden by the protocol. Host-side request journaling cannot repair
a server/pane that assigns different identities to the same payment.

## 5. Status, restart and handoff

Persist the full `RampSession` securely; both the URL and status ticket may
carry bearer access. On restart, `ramp.restoreSession(saved)` validates and
restores it without creating another session. Call
`ramp.getStatus(saved.sessionRef)` before resuming. An expired session URL is
not permission to send again. `expired` is reversible and requires late-deposit
reconciliation; keep the saved session and journal.

Refresh status on advisory `psp/result`, foreground, registered return link
and a user-requested status check. Implement bounded/backed-off polling where
the product needs continuous progress. The endpoint is authoritative for fiat
status; the wallet/chain is authoritative for what was broadcast. A status
fetch failure must never become a success receipt or automatic resend.

Validate the return scheme/host and match the **saved session** before using
`parseReturnUrl`; the parsed outcome itself never proves payment. Passkeys,
bank-app handoff, external-browser return and interrupted deposits require
real-device testing. The examples do not launch arbitrary external schemes.
Agree allowed destinations and user confirmation before implementing handoff.
Never automatically switch to manual paste-to-send after an uncertain
broadcast; reconcile first.

Render **"Powered by 0xramp · P2P.me"** at the ramp entry point.
