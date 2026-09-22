# @0xramp/sdk

TypeScript SDK for wallet apps that want to offer 0xramp ZEC ↔ local-fiat ramps (Pix, UPI, …) by hosting **`0xramp.app`** in an embedded WebView — origin visible, always.

Your wallet signs **only** ZEC sends from its own wallet core. Everything else — identity (passkeys), the Base account, P2P.me orders, quotes, limits, fraud screening, fiat payout — runs inside `0xramp.app`, unchanged.

> [!WARNING]
> **Under active development — not ready for production use.** This is a v0 pilot (`0.x`): the public API and the PSP-v1 wire format are additive-only until the protocol freezes at `0.1.0`, and the package is not yet on npm (see [Install](#install)). Develop against the [sandbox pane](sandbox/) and the [golden fixtures](fixtures/) — expect changes.

> **Attribution:** integrations must display **"Powered by 0xramp · P2P.me"** at the ramp entry point.

## How it works (v0: host mode)

```
Your wallet app                 0xramp.app (pane, in WebView)        0xramp hosted API
┌───────────────────────┐       ┌───────────────────────────────┐     ┌──────────────────┐
│ SDK: createSession ───┼──────►│ partner landing route         │◄───►│ partner sessions │
│ SDK: bridge  ◄────────┼──────┤ passkeys · Base account ·     │     │ (create/status)  │
│  onZecSendRequest ────┼──────┤ P2P.me orders · quotes ·      │     │ rail sessions ·  │
│   → wallet signs ZEC  │       │ limits · fraud · fiat payout │     │ read-only recon. │
└───────────────────────┘       └───────────────────────────────┘     └──────────────────┘
```

- **SELL (ZEC → fiat):** the pane reserves a NEAR Intents deposit route and asks your app to send the exact ZEC amount to a transparent deposit address. Your wallet signs that send — **the only signature you ever make**.
- **BUY (fiat → ZEC):** the user pays a merchant on the fiat rail from their bank app; ZEC lands on the transparent address you provided.
- Bridge results are **advisory**; authoritative state is the ticketed status endpoint plus your own view of the Zcash chain.

Details: [`docs/DESIGN.md`](docs/DESIGN.md) · full surface: [`docs/SPEC.md`](docs/SPEC.md).

## Install

> [!NOTE]
> **Not published to npm yet** (v0 pilot) — install from the repository until the first tagged release:

```bash
git clone https://github.com/0xramp-labs/0xramp-sdk.git
cd 0xramp-sdk
npm ci --ignore-scripts && npm run build   # tsc → dist/ (ESM + .d.ts)
```

Then link the repo from your app: `"@0xramp/sdk": "file:<path-to-repo>"` in `package.json` (the [React Native example](examples/react-native-host/) links the repo root directly) or `npm link`.

Pure ESM, strictly typed, React-free. Targets React Native, Electron, and browsers. Zero runtime dependencies besides schema validation.

## Quickstart

```ts
import { createRampClient, createZecSendStore } from "@0xramp/sdk";

// One durable, secure storage namespace per unlocked wallet.
const sendStore = createZecSendStore({
  get: key => secureWalletStorage.get(key),
  set: (key, value) => secureWalletStorage.set(key, value),
});

const ramp = createRampClient({
  environment: "production",
  partnerId: "<issued-by-0xramp>", // onboarding via 0xramp
  sendStore,
});

// 1 — open a session
await secureSessionStorage.saveCreationIntent(partnerSessionId);
const session = await ramp.createSession({
  direction: "sell", asset: "ZEC", fiat: "BRL",
  partnerSessionId, // correlation, not a guarantee of server idempotency
});
await secureSessionStorage.save(session);

// 2 — attach before loading the pane; explicitly bind each new session
const bridge = ramp.attachPaneBridge({
  sessionRef: session.sessionRef,
  transport: myTransport, // postMessage/IPC adapter — see examples/
  onZecSendRequest: (request, { signal }) =>
    myWallet.confirmAndSend(request, { signal }),
  onSendRecoveryRequired: showRecoveryScreen,
  onResult: () => { void refreshAuthoritativeStatus(); },
  onClose: teardownPane,
});

// 3 — use this policy for the initial source AND every navigation
if (!ramp.isAllowedPaneUrl(session.sessionUrl)) throw new Error("origin refused");
loadWebView(session.sessionUrl);

// 4 — authoritative status; never turn advisory bridge data into a receipt
const status = await ramp.getStatus(session.sessionRef);

// 5 — close detaches listeners and aborts pending confirmation, not broadcasts
bridge.close();

// App restart: restore the secure session, check status, attach a fresh bridge.
ramp.restoreSession(await secureSessionStorage.load());
```

`myWallet`, storage and UI methods above are partner-owned ports. An approved
send returns `{ txid }`; use `{ cancel: true, reason }` only when no broadcast
occurred. Errors, ambiguous multiple transaction IDs and interrupted sends stay
pending for reconciliation. Never retry a send or session-creation POST blindly.

The [partner guide](docs/partner-guide.md) explains exact origins, native
transport, durable recovery and multiple transaction IDs. The
[readiness checklist](docs/partner-readiness.md) separates simulated coverage
from live API/device/settlement evidence. **QR-PAY is outside this SDK's v0
scope.** The RN example's live wallet adapter is deliberately disabled; the
Electron example is local sandbox only.

## What the SDK never does

Signs or moves funds · holds keys or custody · stores or transits payout keys · invents limits/corridors/catalogs · hides origins · trusts client-declared completion for irreversible decisions.

## Repository map

| Path | Contents |
|---|---|
| `docs/` | [`SPEC.md`](docs/SPEC.md) (public surface), [`DESIGN.md`](docs/DESIGN.md) (architecture), [partner guide](docs/partner-guide.md) (RN + Electron recipes) |
| `src/` | `protocol/` (PSP-v1 types + validation) · `session/` (client) · `bridge/` (host-side bridge, origin lock) · `units/` (integer money math) |
| `fixtures/` | PSP-v1 golden wire vectors (conformance set — both sides of the bridge validate against these) |
| `sandbox/` | `sandbox-pane.html` — pane half of PSP-v1 against canned responses; develop hosts with zero 0xramp access |
| `examples/` | Minimal Electron and React Native hosts |

## Development

```bash
npm ci --ignore-scripts # pinned dependencies, no lifecycle scripts
npm run build   # tsc → dist/ (ESM + .d.ts)
npm test        # vitest (includes golden-fixture parity)
npm run test:partner # opt-in simulated host lifecycle; no Expo/Electron installation
npm run audit   # npm audit --omit=dev
```

License: MIT (see [LICENSE](LICENSE)) — "Powered by P2P.me" attribution is a term of use.
