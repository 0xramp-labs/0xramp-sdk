# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[semver](https://semver.org/).

## [Unreleased]

### Added

- Web host example (`examples/web-host/`): a zero-install browser reference
  for the bridge-less **popup hosting mode** (create → open popup → advisory
  return link → ticketed status), mirroring the React Native host controller
  and covered by the opt-in partner test suite. Sandbox mode is fully
  synthetic; live mode requires issued partner configuration and never falls
  back to fake success. Serves as the reference integration shape for web
  partners; see the partner guide §9.
- Browser-hosted pane support for mobile hosts: the pane can open in the
  system browser (an OS auth-session, e.g. `openAuthSessionAsync`) — a
  supported hosting mode required for passkey-first products, which WebViews
  cannot serve (no WebAuthn on Android WebView; iOS WKWebView would need a
  `webcredentials` association file 0xramp does not serve). The partner guide
  gains a "Mobile: browser-hosted pane" recipe (create → open → return link →
  authoritative status, stage-1 SELL without any bridge) — **planned
  pane-side work, not yet live in the deployed pane** (no QR/copy outside a
  native WebView; no return-link navigation yet; the guide marks the current
  state); DESIGN and SPEC name the hosting modes.
- Draft zec-send deep-link handoff codec for that mode — **unfrozen, pending
  partner confirmation; encoding may change and pane-side conformance is not
  claimed**: `parseZecSendHandoffUrl` (pane → wallet payment request; the
  expected session is required — a link from any other session throws
  `SessionMismatch`; fail-closed on duplicated query parameters, malformed
  parameters, and non-canonical amounts; a trailing `#fragment` is ignored;
  output is `ZecSendRequestPayload`-compatible so the existing
  `sendStore` claim/journal semantics apply unchanged) and
  `buildZecSendResumeUrl` (wallet → pane resume URL with advisory txid
  evidence, 1–32 × 64-hex; the 2048-character deep-link bound binds first —
  roughly 28–30 txids fit on realistic pane URLs, larger sets reconcile via
  the status endpoint). Exported from the root package and
  `@0xramp/sdk/session`. Draft vectors live in `fixtures/psp-v1/draft/`
  (excluded from the frozen PSP-v1 conformance set by layout, documented in
  its README) and are regression-protected by a colocated draft-vector test.
  The sandbox pane gains a browser-mode handoff simulation.

### Changed

- Partner guide corrections: the iOS initial-load attribution is fixed
  (CHANGELOG 0.0.1 recorded the iOS gap; the guide wrongly attributed it to
  Android — the create/restore origin lock already covers the initial load),
  the `idempotency-key` deployment contract is documented as verified against
  the issued staging Partner API (identical key + body → identical session,
  changed body → `409 idempotency_conflict`, no quota consumption), and the
  onboarding section now states explicitly that partners receive a public
  partner ID + origins — never a secret API key.
- `createSession` now rejects a `returnUrl` whose scheme is not letter-first
  per RFC 3986 with `ConfigError` before any POST — digit-first schemes and
  values without a scheme prefix fail closed; `https:` URLs and schemes
  without `//` are accepted; an absent `returnUrl` stays a no-op. Register
  the exact string: the server's return-link allowlist compares the full
  value exactly — a query string or fragment makes session create fail with
  403. Enforced client-side: the wire schema and golden fixtures are
  unchanged.

### Fixed

- `parseReturnUrl` no longer reads a `#fragment` as part of the query in
  scheme-without-`//` links (e.g. `zingo:ramp?…#f`): the fragment is ignored,
  matching the URL standard.

## [0.0.2] — 2026-09-22 (partner integration hardening)

### Fixed

- Queued wallet callbacks no longer start after bridge closure; close messages
  detach listeners before host callbacks. In-flight confirmation receives an
  abort signal and late broadcast outcomes are persisted for recovery.
- Ready payloads cannot bind a different envelope session. Custom deployments
  no longer trust sibling tenants derived from a shared parent hostname.
- The sandbox uses the React Native JSON bridge and receives string replies
  on both native event targets, while retaining browser object transport.
- RN host lifecycle now attaches each session before load, restores securely
  saved tickets, checks authoritative status and blocks uncertain creation or
  expiry. Live failures never become sandbox success; the unimplemented live
  wallet adapter explicitly refuses sends.
- Electron's local-only demo uses the real SDK with validated IPC senders,
  exact fixture navigation and cleanup. Live iframe/PANE_URL claims and raw
  envelope logging were removed.

### Added

- Optional `createSession` `idempotencyKey` carried only in the HTTP header for
  explicit recovery on deployments that support idempotent creation. The SDK
  never retries automatically; persist the random key and identical input first.
- `createZecSendStore`, `createMemoryZecSendStore` (sandbox only), and journal
  interfaces. Durable claims precede signing; verified outcomes precede replies.
  Stored outcomes survive bridge recreation; unresolved claims never auto-resend.
- Additive PSP-v1 `psp/zec-send-pending` plus optional result `txids`, schemas
  and golden fixtures. Wallet adapters can preserve multiple transaction IDs
  without guessing which one paid the deposit. Deployed panes must adopt the
  fixtures before a live pilot; protocol changes require CODEOWNERS review.
- `restoreSession`, `isAllowedPaneUrl`, exact `paneOrigins`, configurable
  network deadlines covering response bodies and refusal of API redirects.
- Regression tests, opt-in `test:partner` host simulation, and explicit
  partner-readiness gates for API, native device and real settlement tests.

### Migration (host API changes in this v0 release)

- Supply a persistent wallet-scoped `sendStore` with `onZecSendRequest`.
  Cross-process storage requires atomic claims; memory is not live replay protection.
- Wallet handler throws/invalid output now mean pending reconciliation rather
  than cancellation. Return cancel only after proving no broadcast occurred.
- `sendZecSendResult` and `sendZecSendCancel` now return promises; await them
  and handle persistence failures. `onSendRecoveryRequired` surfaces pending work.
- Configure exact pane origins when using a separate API host. Validate
  native fetch redirect behavior. Never automatically retry creation POSTs.
- This release is for development/pilot review, not a production certification.

## [0.0.1] — 2026-09-21 (scaffold)

### Added

- PSP-v1 protocol module (`@0xramp/sdk/protocol`): envelope/message types, zod
  schemas, stable error taxonomy, redaction helpers (`sessionRef` hashed,
  `statusTicket` fully redacted in logs).
- Session client (`@0xramp/sdk/session`): `createRampClient` with
  `createSession` (ticketed, stateful), `getStatus` (read-only, ticketed),
  `parseReturnUrl` (advisory), and `attachPaneBridge` wiring. Production base
  URL built-in; staging requires an onboarding-issued `apiBaseUrl`.
- Host-side pane bridge (`@0xramp/sdk/bridge`): typed dispatch of
  `psp/ready`, `psp/zec-send-request`, `psp/result`, `psp/close`; replies
  `psp/zec-send-result` / `psp/zec-send-cancel`; fail-closed on unknown
  envelope versions, schema violations, session mismatches; single-use
  `requestId`; origin-lock helpers for WebView navigation.
- Integer money helpers (`@0xramp/sdk/units`): canonical decimal string ↔
  bigint, zatoshi (10⁻⁸ ZEC) and 6-decimal fiat/USDC formatting, no-float guards.
- Golden wire fixtures (`fixtures/psp-v1/`) + fixture-parity test — the
  cross-repo conformance set shared with the pane implementation.
- Sandbox pane (`sandbox/sandbox-pane.html`): pane half of PSP-v1 against
  canned responses for host development and CI.
- Example hosts: `examples/electron-host/`, `examples/react-native-host/`.
- CI: strict typecheck, tests, audit, publish dry-run on Node 20/22.

### Fixed

- `@0xramp/sdk/session` subpath export: `src/session/index.ts` was missing,
  so the documented subpath import failed at runtime (export map pointed at a
  file `tsc` never emitted).
- `requestId` is now single-use **forever**: a replayed `psp/zec-send-request`
  after the first request completed was previously dispatched again (double
  wallet-sign risk). In-flight replays were already rejected.
- Electron example: `main.js` loaded the pane directly as the top-level
  window, so `host.html` (the host bridge half) never ran. It now loads
  `host.html?paneUrl=…` (via `pathToFileURL`, Windows-safe) and the origin
  lock uses `will-frame-navigate` to cover iframe navigations too.
- `ApiError` messages no longer contain the raw `sessionRef` (redacted, per
  the logging contract).

### Changed

- `createSession` now refuses (fail closed) any `sessionUrl` returned by the
  API outside the pane origin allowlist (derived from the configured API
  origin) — defense in depth against a hijacked create response, and cover
  for the iOS initial-load gap where `onShouldStartLoadWithRequest` is not
  called.
- The bridge binds only on the first accepted `psp/ready`; any other message
  on an unbound bridge is rejected instead of binding (matches the documented
  contract).
- A missing `fetch` in the runtime now raises `ConfigError` at construction
  instead of an opaque `TypeError`.
- Status tickets held in memory are capped (most recent 16 sessions).
- Release workflow gates the tag against `package.json` version and a dated
  CHANGELOG entry; the CI publish dry-run mirrors `--access public`.
- RN example actually calls `createSession` (with sandbox fallback), aligns
  `originWhitelist` with the partner guide, and validates the session URL
  before first load; partner guide documents the iOS initial-load gap.

### Out of v0 (explicit descope)

- Variant A stateless URL builder (plan §4.1 channel 2): deferred until the
  partner landing route exists server-side (sibling ticket S1); hosts use the
  server-issued `sessionUrl` only.
- Canonical serialization helpers: deferred — v0 has no signed digests;
  return-URL parsing ships instead.
- Playwright e2e for `examples/electron-host` (plan §10.3): deferred to M3;
  the example is runnable manually (`npm start`) and conformance is carried
  by the vitest fixture-parity suite.

### Notes

- v0 scope: session opener, bridge, status reader. No signer, no orchestrator,
  no custody — the wallet signs only ZEC sends (SELL leg).
- "Powered by 0xramp · P2P.me" attribution is required in integrations.

[0.0.1]: https://github.com/0xramp-labs/0xramp-sdk/releases/tag/v0.0.1
[0.0.2]: https://github.com/0xramp-labs/0xramp-sdk/compare/v0.0.1...v0.0.2
