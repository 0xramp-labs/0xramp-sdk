# `@0xramp/sdk` — Design (v0: host mode)

> **Status:** draft for partner review · Companion document: [`SPEC.md`](./SPEC.md) (public API surface).

## How a partner integration works (v0: "host mode")

0xramp is non-custodial by construction: the order that moves money is placed **on-chain by the user's wallet** on P2P.me (Base), and the ZEC ↔ USDC conversion runs through NEAR Intents. 0xramp provides the session layer, verification, receipts, and a **read-only** reconciler — it never signs, custodies, or terminalizes funds.

A Zcash wallet cannot place a Base order by itself. So in host mode, the **entire fiat/Base machinery stays inside `0xramp.app`**, loaded in a partner-hosted WebView with the origin visible:

```
Partner wallet app                0xramp.app (pane, in WebView)          0xramp hosted API
┌───────────────────────┐        ┌───────────────────────────────┐      ┌──────────────────┐
│ SDK: createSession ───┼───────►│ partner landing route         │◄────►│ partner sessions │
│ SDK: bridge  ◄────────┼───────┤ passkeys · Base account ·     │      │ (create/status)  │
│  onZecSendRequest ────┼───────┤ P2P.me orders · quotes ·      │      │ rail sessions ·  │
│   → wallet signs ZEC  │        │ limits · fraud · fiat payout │      │ read-only recon. │
└───────────────────────┘        └───────────────────────────────┘      └──────────────────┘
```

- **SELL (ZEC → fiat):** the pane reserves a NEAR Intents deposit route and asks the host (via the bridge) to send the exact ZEC amount to a transparent deposit address. The host's wallet signs that send — **the only signature the partner ever makes**. The pane's Base account then escrows the converted USDC on the P2P.me protocol and delivers the user's encrypted payout key to the merchant, who pays the fiat rail (Pix, UPI, …).
- **BUY (fiat → ZEC):** the pane creates everything; the user pays the merchant on the fiat rail from their bank app; ZEC is delivered to the transparent address the host provided; the host watches its own chain view.
- **Trust boundaries:** bridge payloads are **advisory**; authoritative partner-visible state is the ticketed status endpoint plus the partner's own view of the Zcash chain. Capability tokens and payout key material never leave the pane. Hosts must lock WebView navigation to 0xramp origins and never obscure the origin.
- **Target recovery paths:** WebView passkey/bank failures fall back to the browser-hosted mode below — a supported hosting mode, not just a recovery rung. Real-device verification is still required; the SDK alone does not implement or prove device behavior. After an uncertain broadcast, reconcile before considering manual paste-to-send or another request.
- **Invariants:** integer-unit money math everywhere; server-authoritative corridors and limits (fail-closed when limits read zero); read-only reconciliation ("escalate, never terminalize"); attribution "Powered by P2P.me".

### Hosting modes

The WebView recipe above is the default for desktop hosts. On mobile, the pane may instead be opened in the **system browser** (an OS auth-session, e.g. `openAuthSessionAsync`) — a **supported hosting mode** required for passkey-first products: Android WebView has no WebAuthn support, iOS WKWebView would need a `webcredentials` association file for `0xramp.app` that 0xramp does not serve, and web sessions do not cross WebView ↔ browser contexts. Browser-hosted mode has no bridge channel (no postMessage): the pane drives the flow on-page, the host resumes via its registered return deep link, and the ticketed status endpoint stays authoritative. The OS browser displaying the `0xramp.app` origin satisfies origin visibility by construction.

### Deep-link handoff trust model

Return deep-links and handoff links are **spoofable by design** — any app on the device can open a registered scheme. Txid evidence carried on a wallet→pane resume link is **advisory**; correlation and exactly-once semantics come from the durable, wallet-scoped send journal keyed by `(sessionRef, requestId)`, and the wallet's **native confirmation sheet is the approval gate** — the SDK never signs. No money-relevant decision ever trusts a link.

## Layering & future

| Layer | Now | Later |
|---|---|---|
| 0 protocol | PSP-v1 (session/bridge/status) | shared wire formats as embedded modes mature |
| 1 api-client | partner session + status | full headless client |
| 2 signer | — (runs inside the pane) | pluggable Base wallet ports for embedded modes |
| 3 orchestrator | — (flows live in the pane) | React-free BUY/SELL state machines |
| 4 partner-ui | bridge callbacks | richer headless UX kits |
| 5 adapters | examples + partner guides | published partner adapter packages |

Later layers change the hosting model, never the custody model: any future embedded signer still belongs to the end user, and 0xramp remains a verifier.

## What the SDK never does

Signs or moves funds · holds keys or custody · stores or transits payout keys · invents limits/corridors/catalogs · hides origins · trusts client-declared completion for irreversible decisions.
