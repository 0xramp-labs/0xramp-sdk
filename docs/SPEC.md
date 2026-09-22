# `@0xramp/sdk` — Public Surface (v0)

> **Status:** under active development — not ready for production use · draft for partner review · **Protocol:** Partner Session Protocol v1 (PSP-v1) · **Package:** `@0xramp/sdk` `0.x` (ESM, TypeScript, React-free)
>
> Companion documents: [`DESIGN.md`](./DESIGN.md) (architecture and trust model) · sandbox pane and golden wire fixtures ship in the repository (`sandbox/`, `fixtures/`).

A TypeScript SDK for wallet apps that want to offer 0xramp ZEC ↔ local-fiat ramps (Pix, UPI, …) by hosting **`0xramp.app`** in an embedded WebView (origin visible). The wallet signs **only** Zcash sends from its own wallet core. Everything else — identity (passkeys), the Base account, P2P.me orders, quotes, limits, fraud screening, fiat payout — runs inside `0xramp.app`, unchanged.

**Attribution:** integrations must display **"Powered by 0xramp · P2P.me"** at the ramp entry point.

## Install & config

```ts
import { createRampClient, createZecSendStore } from "@0xramp/sdk";

const sendStore = createZecSendStore(secureWalletStorage); // one wallet-scoped get/set adapter

const ramp = createRampClient({
  environment: "production",        // "production" | "staging"
  partnerId: "<issued-by-0xramp>",  // public identifier; onboarding via 0xramp
  sendStore,                       // required when supplying a wallet callback
  // optional: paneOrigins (exact HTTPS origins), requestTimeoutMs (default 15000)
  // optional: fetch, logger, locale ("pt" | "en" | "es" | "hi" | "id")
});
```

## The five functions

```ts
// 1 — open a ramp session (SELL: user sends ZEC, receives fiat; BUY: user pays fiat, receives ZEC)
const { sessionUrl, sessionRef, statusTicket, expiresAt } = await ramp.createSession({
  direction: "sell",            // "sell" | "buy"
  asset: "ZEC",                 // v0: "ZEC"
  fiat: "BRL",                  // ISO code of a corridor 0xramp serves
  amountAsset: "0.05",          // optional decimal string (display units; exact quote is made in 0xramp.app)
  zecReceiver: "t1…",           // BUY: transparent Zcash address where ZEC lands
  returnUrl: "mywallet://ramp", // register the scheme in your own app
  partnerSessionId,             // persist before POST; correlation only, not idempotency
});

// 2 — persist the session securely. Attach the bridge before loading the WebView.

// 3 — wire the pane bridge (the pane drives; you handle)
const pane = ramp.attachPaneBridge({
  transport: /* you provide: postMessage/IPC adapter — see examples */,
  sessionRef,
  onZecSendRequest: async (request, { signal }) => {
    // SELL only. Confirm with the user in YOUR wallet UI, sign with YOUR wallet core,
    // broadcast, then return the txid.
    return myWallet.confirmAndSend(request, { signal });
  },
  onResult:  () => { void refreshAuthoritativeStatus(); }, // advisory only
  onSendRecoveryRequired: () => showRecoveryScreen(),
  onReady:    (r) => markSessionLoaded(r), // pane boot confirmation
  onClose:    () => teardownPane(),
});
if (!ramp.isAllowedPaneUrl(sessionUrl)) throw new Error("origin refused");
loadWebView(sessionUrl); // also apply the same policy to every navigation

// 4 — read authoritative status (read-only, ticketed)
const status = await ramp.getStatus(sessionRef); // { outcome, zecTxids?, fiat?, terminal, updatedAt }

// 5 — parse a return deep-link (advisory; reconcile via getStatus or your own chain view)
const result = ramp.parseReturnUrl("mywallet://ramp?…");
```

## Session lifecycle

`created → opened → user-active → { settled | failed | expired | cancelled }`

The SDK surfaces this as a small enum mapped 1:1 from the server status projection. `expired` is a **reversible** projection — hosts must not act on it irreversibly. Treat `psp/result` as immediate UX feedback and the status endpoint as the receipt.

## Bridge events (pane → host), envelope `{ v: 1, type, sessionRef, payload }`

| Event | When | Your obligation |
|---|---|---|
| `psp/ready` | pane loaded | record; no action |
| `psp/zec-send-request` | SELL, 1Click route reserved | durable claim → confirm + sign + broadcast; result/cancel/pending |
| `psp/result` | flow terminal | display; treat as advisory |
| `psp/close` | user finished | tear down pane gracefully |

Host → pane replies:

| Message | Payload | Notes |
|---|---|---|
| `psp/zec-send-result` | `{ requestId, txid, txids? }` | identified deposit transaction; optional list includes `txid` |
| `psp/zec-send-cancel` | `{ requestId, reason }` | confirmed no broadcast (for example native confirmation declined) |
| `psp/zec-send-pending` | `{ requestId, reason, txids? }` | unresolved send; reconcile, never automatically resend |

Pending reasons: `in-progress`, `broadcast-unknown`, `multiple-transactions`,
`storage-unavailable`. Transaction arrays contain 1–32 individual 64-hex IDs;
they are evidence for reconciliation, not proof of fiat settlement. A wallet
callback may return `{ txids }`, but multiple IDs without an identified
deposit `txid` stay pending. Throws and malformed wallet results also stay
pending. This is an additive PSP-v1 message; both host and pane must support
the new fixtures before a live pilot.

Rules enforced by the SDK bridge:

- Every envelope is validated **before** dispatch; malformed messages are dropped. Hosts can close on `onProtocolError` (the examples do).
- Unknown protocol `v` → `UnsupportedProtocolVersion`; the session is refused.
- `requestId` pairs request/response: same-bridge replays are rejected. Across bridge instances a durable journal replays the recorded outcome or returns pending without signing again. The pane MUST reuse the same ID and payment details after reconnect; it MUST NOT create a fresh ID to retry an unresolved payment.
- A message whose `sessionRef` does not match the host's session is dropped and counted (surfaced via the logger, never dispatched).
- `psp/ready` cannot bind the bridge unless its nested `sessionRef` matches the envelope. An explicit host session binding is preferred.
- `psp/close` closes the bridge before invoking the host callback. Queued sends do not start after close; in-flight wallet work receives an abort signal and any later outcome is persisted.

## Recovery and client additions (0.0.2)

- `createZecSendStore(storage)` supplies a journal over secure `get`/`set`
  storage. Reuse one adapter object per wallet; cross-process use requires
  an atomic implementation of `ZecSendStore.claim`. Memory storage is sandbox-only.
- `restoreSession(saved)` revalidates the full session and origin and restores
  the status ticket without a POST. Persist URLs/tickets securely.
- `isAllowedPaneUrl(url)` exposes the client origin policy. Custom deployments
  default to their exact API origin; configure explicit `paneOrigins` when needed.
- `requestTimeoutMs` bounds fetch plus body parsing; redirects and automatic
  retries are disabled. A timed-out POST is unresolved until reconciled.
- `sendZecSendResult` and `sendZecSendCancel` return `Promise<void>` and persist
  before replying. They only accept requests known to that bridge. Manual
  recovery must be backed by wallet history, and persistence failures reject.
- `onSendRecoveryRequired` receives the pending reason/known transaction IDs.
  Display recovery without launching another wallet send.

## Amounts, errors & security posture

- **Amounts.** All money values are canonical decimal strings or integer-unit strings (`amountZat`: zatoshi, 10⁻⁸ ZEC). Never floats. Fiat/USDC legs use 6-decimal units.
- **Errors.** A stable enum: `UnsupportedProtocolVersion`, `OriginLockViolation`, `SessionMismatch`, `SchemaViolation`, `PartnerQuotaExceeded`, `NetworkUnavailable`, …
- **Advisory results.** Never make an irreversible decision on bridge or deep-link data. Authoritative signals: the ticketed status endpoint (`getStatus`) and your own view of the Zcash chain. Return deep-links are spoofable by design.
- **Origin lock.** Lock WebView navigation to 0xramp origins and never obscure the origin. RN WebView `postMessage` carries no origin — messages are only accepted while the navigation-lock invariant holds (checklists in the partner guide).
- **Redaction.** The SDK logger redacts `statusTicket` and hashes/omits `sessionRef`. Treat the `sessionRef + statusTicket` pair as bearer data: it grants read-only status, nothing more.
- **No secrets in the SDK.** `partnerId` is public. The SDK never holds keys, never signs, and never sees payout-key material (Pix/UPI keys are encrypted inside `0xramp.app`, end to end).

## Conformance

The repository's `fixtures/` directory is the golden wire set for PSP-v1 (bridge messages and session create/status shapes). SDK CI validates the host against it. The deployed pane must independently pass the same fixtures; this repository does not prove that deployment. `sandbox/sandbox-pane.html` supplies synthetic browser and React Native message paths without live 0xramp access. See the [readiness checklist](partner-readiness.md) for evidence required beyond simulations.

## Non-goals (v0)

No embedded Base/EVM signer; no passkey/identity outside `0xramp.app`; no fiat catalog (the pane owns display; corridor availability is server-authoritative); no payout-key handling (keys stay inside `0xramp.app`, encrypted to the merchant); no limits caching or invention (on-chain, read fresh, fail-closed at zero); no custody of any kind — the SDK never holds keys or funds. QR-PAY, swaps, referrals, social verification: not in v0.

## Versioning

`0.x` until the pilot completes. The Partner Session Protocol is frozen at `0.1.0`: **additive changes only** afterward (new messages, new optional fields). A breaking change is a new envelope version (`psp/v2`). This package is ESM, strictly typed, React-free, and targets React Native, Electron, and browsers.
