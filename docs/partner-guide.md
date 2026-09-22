# Partner integration guide — hosting the 0xramp pane

This guide is for the partner engineer shipping a v0 pilot integration. It
walks the SELL ZEC → fiat happy path end to end: create a session, attach the
bridge, load the pane, handle the wallet send, and reconcile status. Read
[`SPEC.md`](SPEC.md) for the full public surface,
[`DESIGN.md`](DESIGN.md) for the trust model, and
[`partner-readiness.md`](partner-readiness.md) for the live-pilot evidence
gates.

This guide is **not** for end users (there is no standalone 0xramp app to
open), and it is **not** for building fiat providers, passkeys, or payout
flows — those live inside `0xramp.app` and never cross the bridge.

**Terminology used throughout:**

| Term | Meaning |
|---|---|
| Host | Your app (mobile or desktop) that embeds the SDK |
| Wallet | Your app's ZEC signing capability — you own it |
| Pane | `0xramp.app` content loaded in your WebView |
| Session | One ramp attempt; identified by `sessionRef` |
| Bridge | The message channel between your host and the pane |

## 1. Prerequisites

- **Node >= 20**; the SDK is pure ESM and strictly typed TypeScript.
- **SDK v0.0.2** (`@0xramp/sdk`). Not on npm yet — install from the repo:
  `git clone` then `"@0xramp/sdk": "file:<path-to-repo>"` (see README).
- **Issued by 0xramp during onboarding:** a `partnerId`, at least one enabled
  corridor (e.g. `BRL`), the API origin, and the exact pane origin(s).
- **Your app must provide:** a ZEC wallet core that signs transparent-address
  sends; secure storage scoped to one unlocked wallet; a WebView with
  navigation control; a return-link scheme you register and route yourself.
- **Attribution:** render **"Powered by 0xramp · P2P.me"** at the ramp entry
  point (both examples do).
- **Package version:** SDK is `0.x` — additive-only until PSP-v1 freezes at
  `0.1.0`. Breaking changes would mean a new envelope version (`psp/v2`), not
  a silent mutation.

## 2. Architecture snapshot

```
Your wallet app (host)              0xramp.app pane (WebView)        0xramp hosted API
┌───────────────────────┐           ┌──────────────────────────┐     ┌──────────────────┐
│ SDK: createSession ───┼──────────►│ landing route            │◄───►│ partner sessions │
│ SDK: bridge           ◄──────────►│ passkeys · orders ·      │     │ create / status  │
│  onZecSendRequest ────┼──psp/*───►│ quotes · fiat payout     │     │ (ticketed, RO)   │
│   → your wallet signs │           └──────────────────────────┘     └──────────────────┘
└───────────────────────┘
```

- The SDK calls the **hosted API** for session create/status and talks to the
  **pane** over the bridge. It never signs, never holds keys, never moves
  funds.
- Bridge messages (`psp/result`, return deep-links) are **advisory**. The only
  authoritative signals are the ticketed status endpoint and your own view of
  the Zcash chain.
- SELL: the pane reserves a deposit route and asks your wallet to send the
  exact ZEC amount to a transparent address. BUY: the end user pays from their
  bank app; ZEC lands on the transparent `zecReceiver` **you** supply in the
  create call.

## 3. Environment configuration

Two environments: `"production"` and `"staging"`.

| | API base URL | Pane origins |
|---|---|---|
| `production`, no overrides | built-in `https://0xramp.app` | `0xramp.app` and its subdomains (https only) |
| `staging` (or any `apiBaseUrl` override) | your override; required for `staging` | defaults to the **exact** API origin you passed |

If the API origin and the pane origin differ, pass `paneOrigins` explicitly.
Narrow production to a single origin with `paneOrigins: ["https://0xramp.app"]`.

```ts
import { createRampClient, createZecSendStore } from "@0xramp/sdk";

const sendStore = createZecSendStore({
  get: key => secureWalletStorage.get(key),
  set: (key, value) => secureWalletStorage.set(key, value),
});

const ramp = createRampClient({
  environment: "staging",
  partnerId: "your-issued-partner-id",          // 1–64 chars of [A-Za-z0-9_-]
  apiBaseUrl: "https://api.pilot.example",      // replace with your issued origin
  paneOrigins: ["https://pane.pilot.example"],  // exact https origins; omit only if pane is served from the API origin
  sendStore,
  requestTimeoutMs: 15_000,                     // bounds fetch + body; 1–300000
  // optional: locale ("pt" | "en" | "es" | "hi" | "id"), logger, fetch
});
```

Rules enforced by the client:

- `apiBaseUrl`/`paneOrigins` must be https origins — no credentials, no path,
  no query, no fragment. `ConfigError` otherwise.
- All API requests use `redirect: "error"` and no automatic retries. If you
  inject `fetch` (recommended on RN/Electron), it must honor that policy and
  `AbortSignal`.
- **Validate your native fetch in the device matrix.**
  `TODO: untested — confirm iOS/Android native fetch honors redirect:"error";`
  if not, use a redirect-refusing adapter before go-live.

## 4. Durable wallet-scoped send journal (`sendStore`)

Any bridge with a signing callback (`onZecSendRequest`) requires a
`sendStore`. Construct one per unlocked wallet namespace, over secure storage:

```ts
const sendStore = createZecSendStore({
  get: key => secureWalletStorage.get(key),
  set: (key, value) => secureWalletStorage.set(key, value),
});
```

What the journal does for you:

- Records an **unresolved claim before** invoking your wallet; binds
  `(sessionRef, requestId)` to address, `amountZat`, and memo.
- Persists the outcome **before** replying to the pane.
- On a new bridge or app restart: replays a known outcome; keeps an unresolved
  claim pending and **never** invokes the wallet again automatically.
- Refuses reusing a request ID with different payment data; refuses
  overwriting a final result/cancel.

Constraints you must respect:

- Reuse **one adapter object per wallet**. Serialization is per-adapter-object
  within one JavaScript process. Multiple processes, devices, or extensions
  need a custom `ZecSendStore` with an atomic durable `claim` — key/value
  storage alone does not give cross-process exactly-once.
- Wallet-side recovery must reuse the same request identity. **Never erase an
  unresolved record to retry.**
- Secure-storage failures block signing (pending). Storage loss/restore
  requires reconciling wallet history.
  `TODO: untested — secure-storage size and backup limits on your target`
  platforms (test them; records can hold multi-transaction arrays).
- `createMemoryZecSendStore()` is for tests and the isolated sandbox only.

## 5. Happy path (SELL ZEC → fiat)

One canonical path. Steps 1–6 are required; steps 7–8 are the resume and
return-link branches.

### Step 1 — Persist the creation intent, then create the session

Goal: open one ramp session, with a durable record that survives a lost
response.

- Call: `await ramp.createSession(input)`
- Routes: `POST /api/partner/v0/sessions` (create),
  `GET /api/partner/v0/sessions/{sessionRef}` (status). Confirm with 0xramp
  that your issued API serves these routes **and** that the deployed pane
  passes the PSP-v1 fixtures (including `psp/zec-send-pending`). A reachable
  homepage or OPTIONS response proves nothing.

```ts
// Your own secure storage; the name here is illustrative.
await sessionVault.saveCreationIntent(partnerSessionId);

const session = await ramp.createSession({
  direction: "sell",
  asset: "ZEC",
  fiat: "BRL",                       // enabled corridor from onboarding
  returnUrl: "mywallet://ramp",      // a scheme YOUR app registers and routes
  partnerSessionId,                  // correlation only; never a recovery credential
});
```

Request shape (all fields):

```ts
interface CreateSessionInput {
  idempotencyKey?: string;   // 32–128 chars of [A-Za-z0-9_-]
  direction: "sell" | "buy";
  asset: "ZEC";
  fiat: string;              // ISO 4217
  amountAsset?: string;      // display hint; exact quote is made in 0xramp.app
  zecReceiver?: string;      // BUY: transparent t-addr the end user receives on
  returnUrl?: string;        // ≤ 2048 chars
  partnerSessionId?: string;
}
```

- Success response to check:

```ts
interface RampSession {
  sessionUrl: string;    // load this in the WebView (may be ticket-bearing)
  sessionRef: string;    // session identity on the bridge and status calls
  statusTicket: string;  // bearer for the read-only status endpoint — never log raw
  expiresAt: string;     // ISO 8601 expiry of the create offer
}
```

- Then persist the full session: `await sessionVault.save(session);`
- Failures you will actually hit: `ConfigError` (malformed input),
  `ApiError` (non-2xx; `.status` carries the HTTP code),
  `PartnerQuotaExceeded` (HTTP 429), `NetworkUnavailable` (timeout or
  unreachable — the POST is **unresolved** server-side until reconciled),
  `OriginLockViolation` (sessionUrl outside your configured pane origins).

**Lost create response.** A timeout may follow a successful POST. Keep the
persisted intent and reconcile with 0xramp before another create.
`partnerSessionId` is public correlation data and cannot recover anything.

**Optional — idempotent creation.** Only if your deployment explicitly
supports it: generate 32 random bytes, base64url-encode them (43 chars), and
persist `idempotencyKey` together with the **complete** create input before
sending. The SDK sends it as the `idempotency-key` HTTP header and never retries.
An explicit recovery must reuse the identical key and body.
`TODO: untested — the 409 behavior for a reused key with a changed body is`
stated here but not documented in SPEC.md; confirm the contract with 0xramp
before relying on it. Do not assume the header adds any guarantee to an older
server. The RN example stays conservative and reconciles manually.

### Step 2 — Attach the pane bridge (before loading the WebView)

Goal: have the bridge live before any pane message can arrive, bound to this
session.

```ts
const bridge = ramp.attachPaneBridge({
  sessionRef: session.sessionRef,   // explicit binding; do not rely on the default
  transport,                        // your PaneTransport — see step 3
  onZecSendRequest: async (request, { signal }) => {
    // Your wallet: show address/amount/fee, get user confirmation,
    // check balance, sign, broadcast. Integer zatoshi only.
    return wallet.confirmAndSend(request, { signal });
  },
  onReady: () => { /* pane booted; session really loaded */ },
  onResult: () => { void refreshAuthoritativeStatus(); },  // advisory only
  onSendRecoveryRequired: () => showRecoveryScreen(),
  onClose: () => teardownPane(),
  onProtocolError: () => { bridge.close(); /* check status before resuming */ },
});
```

- `sessionRef` defaults to the most recently created session on this client;
  pass it explicitly whenever more than one session exists.
- `onZecSendRequest` without `sendStore` throws `ConfigError`.
- Bridge lifecycle rules:
  - Close the old bridge before switching sessions and on unmount.
  - Attach a **fresh** bridge before loading each pane.
  - `psp/close` closes the bridge (detaches the transport listener, aborts the
    pending-confirmation `AbortSignal`) **before** calling `onClose`.
  - An in-flight wallet outcome arriving after `close()` is still journaled —
    the reply to the pane is suppressed, not the persistence.
  - Your wallet adapter must check `signal.aborted` before signing; `close()`
    cannot undo a broadcast already started.

### Step 3 — Implement the transport and load the pane

Goal: connect bridge messages to your platform's messaging primitive.

The transport interface is two functions (see `src/bridge/transport.ts`):

```ts
interface PaneTransport {
  post(message: unknown): void;                       // host → pane (JSON-serializable)
  subscribe(handler: (raw: unknown) => void): () => void; // pane → host; returns unsubscribe
}
```

React Native (from `examples/react-native-host/App.tsx`):

- Host → pane: `webViewRef.current.postMessage(JSON.stringify(message))`.
- Pane → host: the pane calls
  `window.ReactNativeWebView.postMessage(JSON.stringify(envelope))`; the
  sandbox pane listens on both `window` and `document` (accommodates the iOS
  and Android delivery targets) and dedupes each event.
- In `onMessage`, validate `event.nativeEvent.url` with
  `ramp.isAllowedPaneUrl` **before** dispatching to the bridge — RN
  `postMessage` carries no origin.

Electron (from `examples/electron-host/main.js`): IPC in the main process;
verify `event.sender`, sender frame, and frame URL before accepting a message.
The example is a **local sandbox demo** and refuses live `PANE_URL` overrides.

Load the pane:

```ts
if (!ramp.isAllowedPaneUrl(session.sessionUrl)) throw new Error("origin refused");
// Note: createSession/restoreSession already enforce this policy; the check
// here is belt-and-braces. The real obligation is below.
loadWebView(session.sessionUrl);
```

Then enforce the same policy on **every** navigation, redirect, and popup:

- Use `ramp.isAllowedPaneUrl(url)` for the initial source **and every
  navigation**. Reject non-top-frame loads; refuse popups (`setWindowOpenHandler`
  deny / `setSupportMultipleWindows` with a no-op handler).
  `TODO: untested — initial WebView loads can bypass onShouldStartLoadWithRequest;`
  verify the exact platform behavior (iOS vs Android) on real devices.
  (CHANGELOG.md says the guide documents an iOS initial-load gap; this section
  currently attributes it to Android — reconcile during device testing.)
- Bridge messages alone never authenticate an origin; keep the navigation
  invariant and validate the sender URL on every `onMessage`.
- Display the pane **origin**, never the full ticket-bearing URL.
- Configure popup, file-access, and mixed-content policies
  (`allowFileAccess: false`, `mixedContentMode: "never"` in the RN example).
- For a live desktop host use a **top-level** pane surface with visible origin;
  server `frame-ancestors`/X-Frame-Options may forbid iframes — do not strip
  those headers. Keep `sandbox: true`, `contextIsolation: true`,
  `nodeIntegration: false`; expose only a narrow preload channel.

### Step 4 — Handle the send request in your wallet

Goal: confirm, sign, and broadcast exactly the requested deposit — once.

- The pane sends `psp/zec-send-request` with:

```ts
interface ZecSendRequestPayload {
  requestId: string;       // stable across reconnects for the same payment
  address: string;         // transparent t-addr
  amountZat: string;       // integer zatoshi (10^-8 ZEC) as a string — never a float
  memo?: string;
}
```

- Your handler returns a `ZecSendOutcome` (or throws — see table):

| Wallet outcome | Bridge reply to the pane |
|---|---|
| `{ txid }` | `psp/zec-send-result` — the identified deposit transaction |
| `{ txid, txids }` with `txids` containing `txid` | result, plus all related IDs |
| `{ txids: [one] }` | result for the single transaction |
| `{ txids: [first, second] }` | `psp/zec-send-pending` (`multiple-transactions`) |
| `{ txid, txids }` where `txids` omits `txid` | pending (`multiple-transactions`) — not an error |
| `{ cancel: true, reason? }` | `psp/zec-send-cancel` — **only when no broadcast occurred** |
| `{ pending: true, txids? }`, a thrown error, or invalid output | pending (`broadcast-unknown`) — never an inferred cancel |

- Wallet APIs can return several transaction IDs (e.g. preparation plus
  payment). Preserve them as an array; never join them into one string and
  never guess which ID paid the deposit. Identify the deposit from wallet
  history and its outputs, or stay pending. Validate amount, destination, and
  fees with integer arithmetic in your native adapter.

### Step 5 — Resolve uncertain sends (pending)

Goal: reconcile, never send again.

- Pending means **reconcile; do not send again** — including after timeout,
  closure, or app restart. An expired session URL is not permission to resend.
- Once wallet history proves the deposit transaction, call:

```ts
await bridge.sendZecSendResult(requestId, verifiedTxid);
```

- Only after proving **no** broadcast occurred:

```ts
await bridge.sendZecSendCancel(requestId, reason);
```

- Both methods apply only to a request this bridge instance received
  (`ConfigError` otherwise) and persist before replying; persistence failures
  reject.
- For recovery across restarts, a custom recovery screen can complete a
  previously claimed record directly through its `ZecSendStore`
  (`ZecSendStore.complete`) before reopening a bridge.
- The pane must keep the same `requestId` across reconnects for the same
  payment intent. Generating a fresh ID to evade an unresolved claim defeats
  recovery and violates PSP-v1. Host-side journaling cannot repair a
  server/pane that assigns different identities to the same payment.

### Step 6 — Read authoritative status

Goal: receipt for the fiat leg.

- Call: `await ramp.getStatus(session.sessionRef)` →
  `GET /api/partner/v0/sessions/{sessionRef}` with your status ticket.

```ts
interface SessionStatus {
  outcome: "created" | "opened" | "user-active"
         | "settled" | "failed" | "expired" | "cancelled";
  terminal: boolean;
  zecTxids?: string[];
  fiat?: { currency: string; amountDisplay: string }; // display-only receipt string
  updatedAt: string; // ISO 8601
}
```

Lifecycle: `created → opened → user-active → { settled | failed | expired | cancelled }`.

- Refresh status on: advisory `psp/result`, app foreground, the registered
  return link, and user-requested checks. Implement bounded/backed-off polling
  where the product needs continuous progress.
- The status endpoint is authoritative for fiat state; the wallet/chain is
  authoritative for what was broadcast. A status fetch failure must never
  become a success receipt or an automatic resend.
- `expired` is **reversible**: keep the saved session and the journal for
  late-deposit reconciliation.
- `fiat.amountDisplay` is a receipt string — never do math on it.
- **Ticket scope:** the client keeps at most 16 status tickets in memory.
  If you run more concurrent sessions, persist the ticket and pass it
  explicitly: `ramp.getStatus(sessionRef, { statusTicket: saved.statusTicket })`.
  A fresh client process must `restoreSession(saved)` first (step 7), or pass
  the ticket option — otherwise `getStatus` throws `ConfigError`.

### Step 7 — Restore on restart (optional branch)

- Persist the full `RampSession` securely — both `sessionUrl` and
  `statusTicket` are bearer-ish. On restart:

```ts
const session = ramp.restoreSession(await sessionVault.load()); // revalidates + origin check
await ramp.getStatus(session.sessionRef);                        // check before resuming
```

- `restoreSession` validates the session and re-registers its ticket without a
  POST. Then attach a **fresh** bridge bound to the restored `sessionRef`
  before loading the pane again. If the saved intent says "creating" (lost
  create response), block and reconcile — do not re-POST.

### Step 8 — Handle the return deep-link (optional branch)

- First validate the scheme/host yourself and match the `sessionRef` against
  your **saved** session; then call `ramp.parseReturnUrl(url)`:

```ts
interface ParsedReturnUrl {
  sessionRef: string | null;                    // null if absent/malformed
  outcome: "settled" | "failed" | "expired" | "cancelled" | null;
  claimsTerminal: boolean;
  params: URLSearchParams;                      // untrusted display data
}
```

- Missing fields are returned as `null`; only structurally unparseable input
  throws `InvalidReturnUrl` (URLs are capped at 2048 chars).
- The parsed outcome **never** proves payment — any app on the device can open
  the scheme. Reconcile via `getStatus` and your chain view.
- Register and route your own scheme; do not assume any wallet already
  supports one (`zingo://ramp` in the SDK docs is only an illustrative
  example). The examples never launch arbitrary external schemes.
- Passkeys, bank-app handoff, external-browser return, and interrupted
  deposits require real-device testing; agree allowed destinations and user
  confirmation with 0xramp before implementing handoff. Never auto-switch to
  manual paste-to-send after an uncertain broadcast — reconcile first.

## 6. Objects you must persist

| Object | Where | Why |
|---|---|---|
| Creation intent + `partnerSessionId` (and `idempotencyKey` if used) | secure session storage, **before** the POST | lost-create-response reconciliation |
| Full `RampSession` (`sessionUrl`, `sessionRef`, `statusTicket`, `expiresAt`) | secure session storage | restart/resume without re-creating |
| Send journal records | `sendStore` adapter over wallet secure storage | exactly-once sends and recovery |

Treat the `sessionRef + statusTicket` pair as bearer data: it grants
read-only status, nothing more. SDK logs redact the ticket and hash the
`sessionRef` by default — keep it that way in yours.

## 7. Bridge events reference

Pane → host (envelope `{ v: 1, type, sessionRef, payload }`):

| Event | When | Your obligation |
|---|---|---|
| `psp/ready` | pane loaded | record; no action |
| `psp/zec-send-request` | SELL deposit route reserved | claim → confirm + sign + broadcast → result/cancel/pending |
| `psp/result` | flow terminal | display; treat as advisory; refresh status |
| `psp/close` | user finished | bridge is already closed when your handler runs; tear down UI |

Host → pane replies: `psp/zec-send-result { requestId, txid, txids? }`,
`psp/zec-send-cancel { requestId, reason }`, `psp/zec-send-pending
{ requestId, reason, txids? }` with reason `in-progress` |
`broadcast-unknown` | `multiple-transactions` | `storage-unavailable`.
Transaction arrays hold 1–32 individual 64-hex IDs — evidence for
reconciliation, not proof of settlement.

Enforcement: unknown envelope `v` closes the bridge
(`UnsupportedProtocolVersion`); schema-invalid and session-mismatched messages
are dropped and counted (`bridge.getStats()`) and surfaced via
`onProtocolError`; same-bridge request-ID replays are rejected, while
across-bridge replays come from the durable journal.

## 8. Errors and recovery

Branch on `error.code` (all SDK errors extend `PspError`), never on message text.

| Code | Typical cause | What to do |
|---|---|---|
| `ConfigError` | bad client config, missing ticket, unknown request in manual reply | fix config; pass `statusTicket` explicitly or restore first |
| `ApiError` | non-2xx from the hosted API (`.status` holds the HTTP code) | surface; do not blindly retry |
| `PartnerQuotaExceeded` | HTTP 429 | back off |
| `NetworkUnavailable` | timeout or unreachable API, incl. body read | the request is unresolved — reconcile before any retry |
| `SchemaViolation` | bad API/bridge payload, journal conflicts | fail closed; reconcile |
| `OriginLockViolation` | URL outside configured pane origins | refuse; never wrap the origin in your domain |
| `SessionMismatch` | bridge message for another session | dropped; investigate before resuming |
| `UnsupportedProtocolVersion` | pane spoke an unknown `v` | bridge closed; upgrade the SDK/deployment |
| `InvalidReturnUrl` | unparseable return link | ignore the link; reconcile via status |
| `InvalidAmount` | non-canonical money value | fix the input; never use floats |

There are **no automatic retries** anywhere in the SDK. A timed-out create may
have succeeded server-side — reconcile, then optionally reuse a persisted
`idempotencyKey` with the identical body (see step 1). Do not silently fall
back to the sandbox after a live error.

## 9. Local test checklist (sandbox)

The sandbox pane (`sandbox/sandbox-pane.html`) supplies synthetic browser and
RN message paths with zero 0xramp access; fake transaction IDs exist only
there. Both examples run against it:

```sh
# serve the sandbox for the RN example
python3 -m http.server 8082 --directory sandbox --bind 127.0.0.1   # RN example expects /sandbox-pane.html on a loopback host

# repository-level verification (no examples installed)
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:partner            # opt-in host-lifecycle simulation; real SDK + synthetic adapters
npm run build
```

- [ ] Sandbox loads; `psp/ready` fires and your `onReady` marks it.
- [ ] Simulated send: confirm → `{ txid }` → result reply; decline → cancel reply.
- [ ] Simulated pending: return `{ txids: [a, b] }` → pending reply; recovery screen shows.
- [ ] Kill the app mid-claim; restart → journal replays pending, wallet not re-invoked.
- [ ] `onProtocolError` closes the bridge on a garbage message.
- [ ] RN: navigation lock rejects off-origin loads; `onMessage` validates the sender URL.
- [ ] Electron: IPC sender/frame/URL verification rejects spoofed messages.
- [ ] Attribution string renders at the ramp entry point.

This covers host-controller simulation only — it is **not** device or live-API
evidence (see `partner-readiness.md` for the boundary table).

## 10. Go-live checklist

From `partner-readiness.md` — required before enabling a live wallet adapter:

- [ ] 0xramp issued the partner ID, exact API/pane origins, and enabled corridor.
- [ ] `POST /api/partner/v0/sessions` returns a valid, loadable session and the
      ticketed `GET .../sessions/:sessionRef` works for it (a homepage/OPTIONS/
      local mock is insufficient).
- [ ] The deployed pane passes the shared PSP-v1 fixtures (pending and
      multi-transaction results included) and preserves request IDs across reconnects.
- [ ] Lost create responses have a server-supported reconciliation procedure.
- [ ] Native adapter shows amount/destination/fee, uses integer units, checks
      balance, respects cancellation before signing, and associates requests
      with wallet history.
- [ ] Wallet-scoped journal/session storage survives process death; cross-process
      claims are atomic; backup/reinstall/unavailable-storage/large-record cases tested.
- [ ] Adapter preserves all returned txids and identifies the deposit by outputs;
      unknown results never auto-resend.
- [ ] Real iOS and Android devices pass initial-load/redirect/popup origin locks,
      passkeys, foreground/background, registered return links, and the agreed
      bank/browser handoff. Native fetch refuses API redirects.
- [ ] A controlled real session proves both Zcash deposit and authoritative fiat
      settlement, including failure, expiry/late deposit, and interrupted return.
- [ ] Protocol/fixture CODEOWNERS approved the wire surface before merge.

## 11. Not in this SDK (v0)

The SDK never signs or moves funds, holds keys or custody, stores payout keys,
invents or caches limits/corridors/catalogs, hides origins, or trusts
client-declared completion for irreversible decisions (limits fail closed at
zero, server-side). Out of scope for v0: embedded Base/EVM signers, headless
BUY/SELL orchestrators, fiat catalogs, payout-key handling, passkeys/identity
outside `0xramp.app`, QR-PAY, swaps, referrals, social verification. BUY
requires a transparent receiving address; shielded addresses are rejected.
