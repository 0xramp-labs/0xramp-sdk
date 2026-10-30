# 0xramp mobile simulator — Zingo pilot harness

A zero-install browser harness that plays a **Zingo-like mobile wallet**
hosting the 0xramp pane, for click-through testing of the pilot integration
before the Zingo team wires the real app. No build tooling, no dependencies
beyond the built SDK. This is a development and demo harness, not a
production host.

Open the browser **device toolbar** (Chrome DevTools) for a touch-sized
viewport — the phone frame renders at any width.

## Run

```sh
# Repository root
npm ci --ignore-scripts
npm run build          # tsc → dist/ (the page imports ../../dist/index.js)

# Plain loopback HTTP (sandbox mode)
python3 -m http.server 8084 --bind 127.0.0.1
```

Open `http://127.0.0.1:8084/examples/mobile-sim/sim.html`.

For **live mode** the page must be served over **HTTPS on localhost** so the
partner API's browser-origin allowlist (CORS) accepts it — the staging
registry lists `https://localhost:8085` for the zingo pilot entry
(staging-only; ask 0xramp before registering any other origin):

```sh
openssl req -x509 -newkey rsa:2048 -nodes -days 14 \
  -keyout tmp/dev-key.pem -out tmp/dev-cert.pem -subj "/CN=localhost"
python3 examples/mobile-sim/serve-https.py tmp/dev-cert.pem tmp/dev-key.pem
```

Open `https://localhost:8085/examples/mobile-sim/sim.html` and accept the
self-signed certificate warning once.

## What it simulates

- **The wallet shell**: a neutral Zingo-like app (synthetic balance, ramp
  entry with the required "Powered by 0xramp · P2P.me" attribution, session
  card, native-style confirmation sheet for ZEC sends).
- **Both v0 hosting shapes** (partner guide §5 and §9):
  - **WebView** — the pilot shape: the pane renders in an iframe inside the
    phone with the full postMessage bridge (`attachPaneBridge`), the send
    journal (`sendStore`), and a simulated wallet that returns a fake txid
    after you confirm in the sheet. Drive the pane half with the sandbox
    pane's own buttons (ready / send request / result / close).
  - **System browser** — bridge-less: the pane opens in a popup window
    (the browser-hosted mode passkey-first products need); reconciliation
    happens via the return deep-link and the ticketed status endpoint only.
- **OS deep-link routing** for the registered pilot scheme
  `zingo://0xramp` (exact string, compared character-for-character
  server-side): the deep-link bar routes pasted links and can synthesize a
  return link (settled), a foreign-session spoof (dropped — links are
  advisory), and a pane → wallet **SELL handoff** using the DRAFT codec
  (`parseZecSendHandoffUrl` → confirmation sheet → journal →
  `buildZecSendResumeUrl`, delivered back to the pane as advisory txid
  evidence). The DRAFT encoding is unfrozen and pane-side conformance is
  not claimed — do not build production flows on it.

## Modes

- **Sandbox (default)**: synthetic session against `sandbox/sandbox-pane.html`
  with a scripted status sequence (`created → user-active → settled`). No
  0xramp access, no network, fake txids exist only here.
- **Live**: create/status hit the issued partner API (defaults pre-filled
  for the staging deployment and partner ID `zingo`, enabled for the pilot
  `returnUrl: zingo://0xramp`). Serve over `https://localhost:8085` (above)
  or the create POST fails the CORS preflight. Live errors surface as errors
  and are never replaced with synthetic success; the simulated wallet
  **refuses** live sends (confirm resolves as a cancel) so no fake broadcast
  can ever reach a real session.

  Two live-mode limits discovered on the deployed staging pane:

  - The pane sends `x-frame-options: DENY` / CSP `frame-ancestors 'none'`,
    so the **live pane cannot be iframed in any desktop browser** — the
    WebView shape runs against the sandbox pane only. Native app WebViews
    (the real Zingo integration) are unaffected: XFO/frame-ancestors govern
    HTML frames, not native WebView loads. Use the **system-browser shape**
    (popup) to click through the real deployed pane.
  - The deployed pane does not yet navigate to `returnUrl` at flow end and
    may not emit bridge events on the partner landing route — reconcile via
    the status endpoint (partner guide §9 "Pane readiness").

## Caveats (read before demoing)

- `localStorage` here is demo-only. The `statusTicket` is bearer data;
  real hosts keep it in secure storage scoped per unlocked wallet.
- The deployed pane does not yet navigate to `returnUrl` at flow end and
  may not emit bridge events on the partner landing route — the sandbox
  pane provides those paths for now (partner guide §9 "Pane readiness").
- Deep-link claims never set the session outcome; the sheet is the only
  approval gate and `getStatus` is the only receipt.

## Tests

`sim.test.ts` runs in the opt-in partner suite from the repository root:

```sh
npm run test:partner
```
