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
| Pane | `0xramp.app` content loaded in your WebView (or, in **browser-hosted mode**: the mobile system browser / a desktop web popup; see section 9 for the contract and the deployment status) |
| Session | One ramp attempt; identified by `sessionRef` |
| Bridge | The message channel between your host and the pane |

## 1. Prerequisites

- **Node >= 22.23.4** (a Node.js October 2026 security-release line — 22.23.4
  / 24.22.1 / 26.12.1); the SDK is pure ESM and strictly typed TypeScript.
- **SDK v0.0.3** (`@0xramp/sdk`). Not on npm yet — install from the repo:
  `git clone` then `"@0xramp/sdk": "file:<path-to-repo>"` (see README). The
  browser-hosted recipe (section 9) needs the default branch until the next
  tag: `buildZecSendReply` is listed under Unreleased.
- **Issued by 0xramp during onboarding:** a `partnerId`, at least one enabled
  corridor (e.g. `BRL`), the API origin, and the exact pane origin(s).
- **What onboarding issues — and never issues:** the `partnerId` is a public
  identifier, not a credential. Partners receive no secret API key:
  authorization is the server-side allowlist (partner ID + enabled corridor +
  exact registered `returnUrl` + browser `Origin` where one is sent), and
  session reads are gated by the per-session `statusTicket` issued at create.
  Native clients send no `Origin` header. If a flow asks you for a partner
  API key, that is a misunderstanding of this model.
- **Your app must provide:** a ZEC wallet core that signs transparent-address
  sends; secure storage scoped to one unlocked wallet; a WebView with
  navigation control (desktop/WebView mode), your platform's auth-session
  opener (`openAuthSessionAsync`, mobile), or a top-level popup opener
  (`window.open`, desktop web) — browser-hosted mode; a return-link
  scheme you register and route yourself. In browser-hosted mode it also
  receives the pane's send request (section 9; confirm the deployment you
  target).
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
  sessionUrl: string;    // load this in the WebView (its fragment carries the pane credential)
  sessionRef: string;    // session identity on the bridge and status calls
  statusTicket: string;  // bearer for the read-only status and recorded-request reads — never log raw
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

**Optional — idempotent creation.** On deployments that support it (the
0xramp-issued Partner API does): generate 32 random bytes, base64url-encode
them (43 chars), and persist `idempotencyKey` together with the **complete**
create input before sending. The SDK sends it as the `idempotency-key` HTTP
header and never retries. An explicit recovery must reuse the identical key
and body. Deployment contract (as implemented by the issued staging Partner
API; confirm with 0xramp for custom deployments, and do not assume the header
adds any guarantee to an older server):

- Same key + identical body → the **identical session** is returned (HTTP 200
  recovery, no new create, no quota consumed) — this is the supported
  lost-create-response reconciliation path, across replicas and restarts.
- Same key + **changed** body → `409 idempotency_conflict`; resolve with 0xramp
  before retrying anything.
- Recovery records are never recycled or overwritten.

The RN example stays conservative and reconciles manually.

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
  `TODO: untested — on iOS, initial WebView loads can bypass`
  `onShouldStartLoadWithRequest` (CHANGELOG 0.0.1 recorded the iOS gap); verify
  the exact callback behavior on both platforms on real devices. The gap cannot
  load an off-origin pane: `createSession`/`restoreSession` already refuse any
  `sessionUrl` outside the configured pane origins, so the callback is defense
  in depth for every subsequent navigation, not the initial-load lock.
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

Treat the `sessionRef + statusTicket` pair as bearer data: it grants read-only
access to the session status and to the recorded send request (deposit address,
exact amount, request id, deadline) until retention ends. Keep it on the device
or handle it like payment data. SDK logs redact the ticket and hash the
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
| `HandoffRefused` | a handoff link is not the recorded send request, or it can no longer be sent (`.reason`) | show nothing to the wallet; check status |

There are **no automatic retries** anywhere in the SDK. A timed-out create may
have succeeded server-side — reconcile, then optionally reuse a persisted
`idempotencyKey` with the identical body (see step 1). Do not silently fall
back to the sandbox after a live error.

## 9. Browser-hosted pane (mobile and web hosts)

Mobile hosts can open the pane in the **system browser** (an OS auth-session)
instead of an embedded WebView; desktop **web** hosts open it as a top-level
popup (`window.open`). Both shapes are bridge-less, and this is a
**supported hosting mode**, not a degradation rung — passkey-first products
need it.

### When to choose browser-hosted

- **Passkeys are the critical path.** The pane's identity lives inside
  `0xramp.app` as a WebAuthn credential, and only a real browser engine can
  create and assert it. Android WebView has no WebAuthn support without a
  native credential bridge built into each partner app, and iOS WKWebView
  needs a `webcredentials` (Associated Domains) association file for
  `0xramp.app` that 0xramp does not serve.
- **Web sessions do not cross WebView ↔ browser contexts.** A WebView pane
  plus system-browser login is not a working hybrid — pick one surface per
  session.
- In browser mode the browser chrome itself displays the `0xramp.app` origin
  (OS browser on mobile, popup window on desktop web), which satisfies the
  origin-visibility invariant by construction.
- The WebView recipe (section 5) stays the right shape for desktop (Electron)
  hosts and partners who prefer an embedded pane. Desktop **web** hosts use
  the same bridge-less popup shape as this section — see
  `examples/web-host/` for a runnable reference (create → popup → return
  link → authoritative status). That example has no wallet adapter: it reports
  the send-request link instead of serving it, and a web host needs its own
  signing path to fund a SELL.

### Pane readiness (current state)

Pane-side support for this mode does not reach every deployment at once:
confirm with 0xramp which deployment you target. Where it is not deployed yet,
the deposit step outside a native WebView still shows a disabled action and the
message "Open this session inside your partner wallet", and nothing navigates
to your `returnUrl`. A session created without a registered `returnUrl` stays
in that state on any deployment: it is required in this mode. The contract
below is what the pane implements. The link
encoding stays a draft until the partner confirms it (see "Handoff codec"),
so any change to it ships as a coordinated pane + SDK release.

- **Handoff.** When the user confirms the deposit, the pane first records one
  send request for the session, then navigates to your registered `returnUrl`
  with that request as dedicated query parameters:
  `<returnUrl>?sessionRef=…&requestId=…&address=…&amountZat=…`. The base is
  the registered string itself (no path segment is added; SELL deposits carry
  no `memo`), so it must not contain `?` or `#` and must leave room for the
  parameters (at most 1600 characters). There is no QR or copy fallback in
  this mode. While no wallet reply is on record and more than 30 s before the
  deadline, the pane can offer the same link again (same `requestId`): your journal's
  exactly-once claim makes a repeat harmless. On a repeat, never ask the
  wallet again; if the outcome is recorded, hand its evidence back again.
- **Resume.** After the native confirmation and broadcast, reopen the pane at
  the **verbatim `sessionUrl`** (query and `#paneToken` fragment intact) with
  the evidence appended by `buildZecSendResumeUrl`. The pane records it
  against the recorded request as an advisory reply (an identified txid or a
  one-element list as a result, even with related IDs; several IDs with no
  identified txid as a pending multiple-transactions reply) and removes it from
  the address once consumed. A single ID on an unresolved send is not evidence
  of the deposit: keep it in your journal until wallet history proves it, then
  hand it back as `txid`. A link without the fragment cannot open the pane.
  A declined send has no resume link: the pane keeps reconciling via status.
  After an uncertain send, never send again and reopen the verbatim
  `sessionUrl`: the sale continues if the deposit lands.
- **Keep the pane open.** The order and the payout key go out from the open
  pane. Once the user is signed in, a reopened pane continues the sale by
  itself, and it needs to stay open until the sale finishes. If the user leaves,
  reopen the verbatim `sessionUrl`; an order left waiting for its payout key can
  be cancelled.
- **What the user does in the pane.** The first sign-in is by email, and a
  passkey can be linked afterwards. A transparent ZEC refund address is required
  before opening a sale and the session has no field for it yet, so show the
  wallet's transparent address for the user to copy first. Send exactly
  `amountZat`, with the network fee on top. Reuse one saved session until its
  status is terminal: a new session is blocked while the account has an open sale.
- **A sale that was confirmed and never sent.** "Confirm in wallet" freezes the
  route, and that account cannot start another sale while it is open. Reopen the
  saved `sessionUrl` and the pane offers the same request again. If your wallet
  did not send and will not, the account owner can close the sale: signed in to
  0xramp outside your wallet, "My wallet did not send" on the status card, or in
  the funding panel of a reopened session. It needs no session credentials, and
  your app cannot do it for them. It is refused while your wallet has reported a
  transaction or an unclear broadcast, or a deposit is visible, so report a
  decline as a decline. Afterwards `verifyZecSendHandoff` refuses the old link
  with `closed`, and status reads `cancelled` with `terminal: false`, because a
  deposit that still lands on the route reopens the sale.
- **React Native.** The SDK's calls work with React Native's own URL classes, but
  they report an empty `hostname` for a custom scheme. Route links on the string,
  as the example host does, or install a WHATWG URL polyfill.
- **Return.** On a terminal outcome the pane navigates once per outcome to
  `<returnUrl>?sessionRef=…&outcome=<settled|failed|cancelled>`, after the
  wallet's reply is recorded, so an auth-session sheet closes itself; the
  pane's "Return to wallet" control navigates on demand. `expired` is not
  terminal and never navigates. Outcomes on links are resume hints:
  `getStatus` stays the receipt.
- **Integrity.** A handoff link proves nothing by itself: any app on the device
  can open your scheme with another address. Before your journal and your
  native sheet, call `verifyZecSendHandoff`. It reads the request 0xramp
  recorded for the session with your status ticket, which the pane never holds,
  and refuses a link that differs, or a request the server no longer calls
  sendable. A failed read means nothing may be sent: offer to reopen the
  verbatim `sessionUrl`, with no evidence, so the pane can offer the link again.

### The recipe (React Native)

There is **no bridge in this mode** — no postMessage channel exists, so
`attachPaneBridge` and the transport steps do not apply. The flow is
create → open → handoff link → native send → resume link → return link →
authoritative status:

```ts
import { buildZecSendReply, buildZecSendResumeUrl, parseZecSendHandoffUrl } from "@0xramp/sdk";

// 1 — create the session as usual (returnUrl scheme rules below)
const session = await ramp.createSession({
  direction: "sell",
  asset: "ZEC",
  fiat: "BRL",
  returnUrl: "mywallet://ramp", // YOUR scheme, registered and routed by YOUR app
  partnerSessionId,
});
await sessionVault.save(session);

// 2 — validate the pane URL, register the link listener FIRST, then open the
//     auth-session browser (host-owned platform API, e.g. expo-web-browser;
//     confirm the exact call signature against your installed version)
if (!ramp.isAllowedPaneUrl(session.sessionUrl)) throw new Error("origin refused");
const sub = Linking.addEventListener("url", ({ url }) => handleLink(url));

// 3 — await the open; consume its result — expo-web-browser resolves it
//     when the sheet closes, and it may carry your link
const result = await openAuthSessionAsync(session.sessionUrl, "mywallet://ramp",
  { preferEphemeralSession: false });
if (result.type === "success" && result.url) handleLink(result.url);
// keep the listener registered across restarts/foregrounding; remove it
// only on teardown (sub.remove())

function handleLink(url: string) {
  // App owns scheme/host routing. Link claims never set the session outcome.
  try {
    const target = new URL(url);
    if (target.protocol !== "mywallet:") return;
    if (target.searchParams.has("requestId")) {
      // Pane → wallet handoff: a payment REQUEST, and deep links are spoofable.
      parseZecSendHandoffUrl(url, { sessionRef: session.sessionRef }); // junk throws here and is dropped quietly
      confirmAndSend(url).catch(error => {
        // A refused link did nothing: drop it quietly. Anything else is unresolved: never send again.
        if (error.code === "HandoffRefused") void refreshStatus();
        else showReconcileScreen();
      });
      return;
    }
    const parsed = ramp.parseReturnUrl(url);
    if (parsed.sessionRef === session.sessionRef) void refreshStatus();
  } catch { /* malformed/unrelated link */ }
}

async function confirmAndSend(url: string) {
  const sessionRef = session.sessionRef;
  // Only the request 0xramp recorded for this session gets past here, and only while
  // the server calls it sendable: before the journal and the sheet.
  const { request, deadline } = await ramp.verifyZecSendHandoff(url, { sessionRef });
  const previous = await sendStore.claim(sessionRef, request);
  let reply = previous?.reply;                  // a replay never reaches the wallet again
  if (previous === undefined) {
    let outcome: unknown;                       // a wallet error stays pending: never auto-resend
    try { outcome = await myWallet.confirmAndSend(request, { deadline }); } catch { /* unknown broadcast */ }
    reply = buildZecSendReply(sessionRef, request.requestId, outcome);
    await sendStore.complete(sessionRef, request, reply).catch(showReconcileScreen);
  }
  // 4 — hand the evidence back on the VERBATIM sessionUrl (fragment intact)
  const evidence = reply?.type === "psp/zec-send-result"
    ? { txid: reply.payload.txid, ...(reply.payload.txids ? { txids: reply.payload.txids } : {}) }
    : reply?.type === "psp/zec-send-pending" && reply.payload.txids && reply.payload.txids.length > 1
      ? { txids: reply.payload.txids }
      : undefined;
  if (evidence === undefined) return;           // declined or unresolved: status and wallet history reconcile
  const back = await openAuthSessionAsync(buildZecSendResumeUrl(session.sessionUrl, evidence),
    "mywallet://ramp", { preferEphemeralSession: false });
  if (back.type === "success" && back.url) handleLink(back.url);
}
```

Route the result of **every** auth-session open through your link handler: on
iOS the sheet's callback URL arrives that way, so dropping it loses the
flow-end return link or a repeated send request. Close your sheet by the verified
`deadline`, because status will not end a recorded request, and cancel it when
status turns terminal. Closing the pane is not a reason to cancel, because the
pane leaves on purpose at the handoff.
`examples/react-native-host/host.ts` shows `handleReturn` and `runHandoff` with
all of that, and also re-checks its own session state after the claim as the
bridge does; `buildZecSendReply` maps a wallet outcome to the PSP-v1 reply the
journal stores, exactly as the bridge does. Refresh
`getStatus(session.sessionRef)` on the return link and on app foreground;
the status endpoint stays the only authoritative receipt.

`TODO: untested — device behaviors in this section need real iOS/Android`
verification before go-live (see the readiness checklist); simulations
cannot prove them.

### Scheme rules

- **Letter-first, per RFC 3986** (`^[a-zA-Z][a-zA-Z0-9+.-]*:`).
  `createSession` rejects anything else with `ConfigError` before the POST —
  digit-first schemes fail, and so does a value with no scheme prefix at all.
  Accepted values include custom schemes with or without `//`
  (`mywallet://ramp`, `zingo:ramp`) and `https:` URLs (universal/app links).
  Register the exact string — the server's return-link allowlist compares the
  full value exactly: any added query string or fragment is rejected with 403
  at session create.
- The registered string is also the handoff base: the pane composes
  `?sessionRef=…` onto it. Register a value without `?` or `#` anywhere and at
  most 1600 characters; other values are refused at registration.
- Register and route the scheme in your own app (Linking config / intent
  filters). `TODO: untested — confirm the exact scheme string your device`
  build registers on iOS and Android; config-time validation can differ from
  runtime registration.
- Keep `zcash:` (ZIP-321 payment URIs) registered separately and unchanged;
  it serves a different purpose. Do not reuse it as the ramp return scheme.

### iOS notes (auth-session sheets)

- `preferEphemeralSession: false` keeps the user signed in to `0xramp.app`
  across ramps; passkey autofill works.
- iOS shows its website-data-sharing consent prompt each time the sheet
  opens — expected behavior, not a bug.
- The sheet closes itself whenever the pane navigates to your return scheme:
  on the handoff link as well as at flow end. Your app therefore reopens the
  pane with the resume link in a new sheet after the send.
- `TODO: untested — verify passkey create/assert inside the auth-session`
  browser on real devices, including returning-user login and the consent
  prompt, before rollout.

### SELL in this mode

1. The user signs in and prices the sale inside the pane as usual.
2. On "Confirm in wallet" the pane records the send request and hands it to
   your app on the registered link (handoff above). Your app is the only
   signing path: there is no QR or copy fallback.
3. Your app reopens the pane with the resume link; the pane records the
   evidence, the deposit is detected on-chain and the sale continues by itself
   while the pane stays open.
4. At flow end the pane navigates to your return scheme with the outcome; the
   sheet closes; your app refreshes status from the ticketed status endpoint —
   the authoritative receipt for the fiat leg.

BUY in this mode is not available end to end: the Partner API serves SELL
sessions in this flow, and the pane's browser path does not complete BUY. It
remains the designed direction: ZEC lands on the transparent receiver you
registered in the create call, and your wallet sees it natively. Attribution
("Powered by 0xramp · P2P.me") is required at the ramp entry point in this
mode too.

### Handoff codec (DRAFT, unfrozen)

The pane emits the draft encoding below. It freezes with the partner's
confirmation of the return scheme and the wallet send API; until then any
change ships as a coordinated pane + SDK release:

- `ramp.verifyZecSendHandoff(url, { sessionRef })` is what a host calls: it
  parses the link, reads the request 0xramp recorded for the session with the
  status ticket (`GET …/sessions/:sessionRef/send-request`,
  `ramp.getRecordedZecSendRequest`) and returns `{ sessionRef, request, deadline }`
  only if the link is exactly the recorded request and the server's `state` is
  `sendable`. Otherwise it throws `HandoffRefused` with `reason`: `not-recorded`,
  `mismatch`, `answered` (a wallet reply is on record), `past-deadline` (at or
  within 30 s of the deadline, on the server's clock) or `closed` (the route no
  longer accepts this deposit: already paid, ordered or closed by 0xramp). Network
  and schema failures throw their own codes, and any failure means nothing may be
  sent. Call it before `sendStore.claim`.
- `parseZecSendHandoffUrl(url, { sessionRef })` is the parser underneath: it
  reads a pane → wallet handoff link (dedicated query params on YOUR registered
  return URL: `sessionRef`, `requestId`, transparent `address`, canonical integer
  `amountZat`, optional `memo`). It fails closed on session mismatch,
  malformed parameters, and non-canonical amounts, and returns a
  `ZecSendRequestPayload`-shaped request — so the existing `sendStore`
  claim/journal semantics apply unchanged (exactly-once, replay-safe). Route
  by the presence of `requestId` before falling back to `parseReturnUrl`,
  which would otherwise read a handoff as a plain return.
- `buildZecSendResumeUrl(sessionUrl, { txid?, txids? })` appends advisory
  txid evidence (1–32 × 64-hex) to the verbatim `sessionUrl`, keeping its
  `#paneToken` fragment.

Trust model: deep links are spoofable by design, so a parsed handoff is only a
claim until `verifyZecSendHandoff` matches it against the recorded request and
the server's verdict. Your
wallet's native confirmation sheet remains the only approval gate, and the SDK
never signs. Resume txids are advisory evidence the pane reconciles; the ticketed
status endpoint stays authoritative. Draft wire vectors live in `fixtures/psp-v1/draft/`
(explicitly excluded from the frozen PSP-v1 conformance set). Do not build
production flows on this encoding before it freezes.

## 10. Local test checklist (sandbox)

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

## 11. Go-live checklist

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
- [ ] Browser-hosted hosts: the targeted deployment hands the send request to
      your registered return link and navigates back at flow end; links are
      routed by `requestId`, repeated links dedupe by request id, the verbatim
      `sessionUrl` is reopened with the evidence, your scheme launches from the
      pane on the target browsers, and every handoff link passes
      `verifyZecSendHandoff` before your journal and your native sheet (section 9).
- [ ] A controlled real session proves both Zcash deposit and authoritative fiat
      settlement, including failure, expiry/late deposit, and interrupted return.
- [ ] Protocol/fixture CODEOWNERS approved the wire surface before merge.

## 12. Not in this SDK (v0)

The SDK never signs or moves funds, holds keys or custody, stores payout keys,
invents or caches limits/corridors/catalogs, hides origins, or trusts
client-declared completion for irreversible decisions (limits fail closed at
zero, server-side). Out of scope for v0: embedded Base/EVM signers, headless
BUY/SELL orchestrators, fiat catalogs, payout-key handling, passkeys/identity
outside `0xramp.app`, QR-PAY, swaps, referrals, social verification. BUY
requires a transparent receiving address; shielded addresses are rejected.
