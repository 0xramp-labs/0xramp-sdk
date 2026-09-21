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
npm ci && npm run build   # tsc → dist/ (ESM + .d.ts)
```

Then link the repo from your app: `"@0xramp/sdk": "file:<path-to-repo>"` in `package.json` (the [React Native example](examples/react-native-host/) links the repo root directly) or `npm link`.

Pure ESM, strictly typed, React-free. Targets React Native, Electron, and browsers. Zero runtime dependencies besides schema validation.

## Quickstart (the five functions)

```ts
import { createRampClient } from "@0xramp/sdk";

const ramp = createRampClient({
  environment: "production",
  partnerId: "<issued-by-0xramp>", // onboarding via 0xramp
});

// 1 — open a session
const { sessionUrl } = await ramp.createSession({
  direction: "sell", asset: "ZEC", fiat: "BRL",
});

// 2 — host the pane: load sessionUrl in your WebView, navigation locked to 0xramp origins

// 3 — wire the bridge; the pane drives, you handle
ramp.attachPaneBridge({
  transport: myTransport, // postMessage/IPC adapter — see examples/
  onZecSendRequest: async ({ address, amountZat }) => {
    const txid = await myWallet.sendToTransparent(address, amountZat);
    return { txid };
  },
  onResult: saveReceipt,
  onClose: teardownPane,
});

// 4 — authoritative status (read-only, ticketed)
await ramp.getStatus(sessionRef);

// 5 — parse a return deep-link (advisory only)
ramp.parseReturnUrl("zingo://ramp?...");
```

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
npm ci          # pinned dependencies
npm run build   # tsc → dist/ (ESM + .d.ts)
npm test        # vitest (includes golden-fixture parity)
npm run audit   # npm audit --omit=dev
```

License: MIT (see [LICENSE](LICENSE)) — "Powered by P2P.me" attribution is a term of use.
