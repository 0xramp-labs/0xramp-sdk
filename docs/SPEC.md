# `@0xramp/sdk` — Public Surface (v0)

> **Status:** under active development — not ready for production use · draft for partner review · **Protocol:** Partner Session Protocol v1 (PSP-v1) · **Package:** `@0xramp/sdk` `0.x` (ESM, TypeScript, React-free)
>
> Companion documents: [`DESIGN.md`](./DESIGN.md) (architecture and trust model) · sandbox pane and golden wire fixtures ship in the repository (`sandbox/`, `fixtures/`).

A TypeScript SDK for wallet apps that want to offer 0xramp ZEC ↔ local-fiat ramps (Pix, UPI, …) by hosting **`0xramp.app`** in an embedded WebView (origin visible). The wallet signs **only** Zcash sends from its own wallet core. Everything else — identity (passkeys), the Base account, P2P.me orders, quotes, limits, fraud screening, fiat payout — runs inside `0xramp.app`, unchanged.

**Attribution:** integrations must display **"Powered by 0xramp · P2P.me"** at the ramp entry point.

## Install & config

```ts
import { createRampClient } from "@0xramp/sdk";

const ramp = createRampClient({
  environment: "production",        // "production" | "staging"
  partnerId: "<issued-by-0xramp>",  // public identifier; onboarding via 0xramp
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
  returnUrl: "zingo://ramp",    // optional deep-link back into your app
});

// 2 — host the pane: load sessionUrl in your WebView with navigation locked to 0xramp origins

// 3 — wire the pane bridge (the pane drives; you handle)
const pane = ramp.attachPaneBridge({
  transport: /* you provide: postMessage/IPC adapter — see examples */,
  onZecSendRequest: async ({ requestId, address, amountZat }) => {
    // SELL only. Confirm with the user in YOUR wallet UI, sign with YOUR wallet core,
    // broadcast, then return the txid.
    const txid = await myWallet.sendToTransparent(address, amountZat);
    return { txid };                       // or throw / return { cancel: true, reason }
  },
  onResult:   (r) => saveReceipt(r),       // advisory terminal feedback
  onReady:    (r) => markSessionLoaded(r), // pane boot confirmation
  onClose:    () => teardownPane(),
});

// 4 — read authoritative status (read-only, ticketed)
const status = await ramp.getStatus(sessionRef); // { outcome, zecTxids?, fiat?, terminal, updatedAt }

// 5 — parse a return deep-link (advisory; reconcile via getStatus or your own chain view)
const result = ramp.parseReturnUrl("zingo://ramp?…");
```

## Session lifecycle

`created → opened → user-active → { settled | failed | expired | cancelled }`

The SDK surfaces this as a small enum mapped 1:1 from the server status projection. `expired` is a **reversible** projection — hosts must not act on it irreversibly. Treat `psp/result` as immediate UX feedback and the status endpoint as the receipt.

## Bridge events (pane → host), envelope `{ v: 1, type, sessionRef, payload }`

| Event | When | Your obligation |
|---|---|---|
| `psp/ready` | pane loaded | record; no action |
| `psp/zec-send-request` | SELL, 1Click route reserved | confirm + sign + broadcast from your wallet; reply result/cancel |
| `psp/result` | flow terminal | display; treat as advisory |
| `psp/close` | user finished | tear down pane gracefully |

Host → pane replies:

| Message | Payload | Notes |
|---|---|---|
| `psp/zec-send-result` | `{ requestId, txid }` | response to a send request after wallet confirm + broadcast |
| `psp/zec-send-cancel` | `{ requestId, reason }` | user declined in the native confirm sheet |

Rules enforced by the SDK bridge:

- Every envelope is validated against the PSP-v1 schema **before** handler dispatch; violations fail closed (session aborted, not degraded silently).
- Unknown protocol `v` → `UnsupportedProtocolVersion`; the session is refused.
- `requestId` pairs request/response and is single-use; replays are rejected.
- A message whose `sessionRef` does not match the host's session is dropped and counted (surfaced via the logger, never dispatched).

## Amounts, errors & security posture

- **Amounts.** All money values are canonical decimal strings or integer-unit strings (`amountZat`: zatoshi, 10⁻⁸ ZEC). Never floats. Fiat/USDC legs use 6-decimal units.
- **Errors.** A stable enum: `UnsupportedProtocolVersion`, `OriginLockViolation`, `SessionMismatch`, `SchemaViolation`, `PartnerQuotaExceeded`, `NetworkUnavailable`, …
- **Advisory results.** Never make an irreversible decision on bridge or deep-link data. Authoritative signals: the ticketed status endpoint (`getStatus`) and your own view of the Zcash chain. Return deep-links are spoofable by design.
- **Origin lock.** Lock WebView navigation to 0xramp origins and never obscure the origin. RN WebView `postMessage` carries no origin — messages are only accepted while the navigation-lock invariant holds (checklists in the partner guide).
- **Redaction.** The SDK logger redacts `statusTicket` and hashes/omits `sessionRef`. Treat the `sessionRef + statusTicket` pair as bearer data: it grants read-only status, nothing more.
- **No secrets in the SDK.** `partnerId` is public. The SDK never holds keys, never signs, and never sees payout-key material (Pix/UPI keys are encrypted inside `0xramp.app`, end to end).

## Conformance

The repository's `fixtures/` directory is the golden wire set for PSP-v1 (every bridge message, session create/status shape, and canonical serialization). SDK CI validates the host side against it; the `0xramp.app` pane validates the pane side against the same set. `sandbox/sandbox-pane.html` implements the pane half of PSP-v1 against canned responses so you can develop and CI-test a host with no 0xramp access.

## Non-goals (v0)

No embedded Base/EVM signer; no passkey/identity outside `0xramp.app`; no fiat catalog (the pane owns display; corridor availability is server-authoritative); no payout-key handling (keys stay inside `0xramp.app`, encrypted to the merchant); no limits caching or invention (on-chain, read fresh, fail-closed at zero); no custody of any kind — the SDK never holds keys or funds. QR-PAY, swaps, referrals, social verification: not in v0.

## Versioning

`0.x` until the pilot completes. The Partner Session Protocol is frozen at `0.1.0`: **additive changes only** afterward (new messages, new optional fields). A breaking change is a new envelope version (`psp/v2`). This package is ESM, strictly typed, React-free, and targets React Native, Electron, and browsers.
