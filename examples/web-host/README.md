# 0xramp example host — Web (popup mode)

Minimal browser host driving the **popup hosting mode** end to end:
create → open popup → return link → authoritative status. No build tooling,
no dependencies, no install step. This is integration reference code for web
partners (a top-level popup under the visible `0xramp.app` origin), not a
production page.

Popup mode is **bridge-less** (partner guide §9): there is no pane bridge, no
wallet callback, and the host is never in the signing path. Sandbox mode uses
only synthetic data; live API errors never fall back to a fake payment.

## Run

```sh
# Repository root
npm ci --ignore-scripts
npm run build          # tsc → dist/ (the page imports ../../dist/index.js)

# Serve the repository root on loopback (the page resolves ../../ paths)
python3 -m http.server 8083 --bind 127.0.0.1
```

Open `http://127.0.0.1:8083/examples/web-host/host.html`. Loopback serving is
a development setting; issued HTTPS origins are required for partner sessions.

- **Sandbox mode** (default): exercises the full controller lifecycle with a
  synthetic session pointing at the sandbox pane and a scripted status
  sequence (`created → user-active → settled`). "Simulate return link" plays
  the pane-side returnUrl navigation that deployed panes do not perform yet
  (planned pane work — see the partner guide §9 readiness notes).
- **Live mode**: requires issued configuration (partner ID, API origin,
  pane origins). Session create/status hit the real hosted API. Live failures
  surface as errors and are never replaced with synthetic success.

## What it demonstrates

- Creation-intent persistence **before** the create POST, and the full session
  afterwards (`host.js` mirrors `examples/react-native-host/host.ts`).
- Popup open only after the client origin policy accepts the session URL;
  expiry and expired-session (reversible) handling.
- Advisory-only return links: the page owns returnUrl routing, parses the
  link, matches `sessionRef`, and reconciles via the ticketed status endpoint.
  Link claims never set the outcome.
- Single-flight status refresh; terminal status clears the local pointer;
  popup-close detection surfaces "check status" instead of guessing.
- Attribution "Powered by 0xramp · P2P.me".

## Caveats (read before copying)

- `localStorage` here is **demo-only**. The `statusTicket` is bearer data:
  real web hosts keep it server-side or in secure storage, scoped per user.
- The exact `returnUrl` string must be registered with 0xramp during
  onboarding; the server compares it character-for-character.
- Partners receive no secret API key (public partner ID + origins only) —
  see the partner guide §1.
- The deployed pane does not yet navigate to `returnUrl` at flow end and
  shows no deposit QR outside a WebView (planned pane-side work); until then
  a live popup run ends at the pane's in-pane states and status polling is
  the receipt path. See [pilot gates](../../docs/partner-readiness.md).
