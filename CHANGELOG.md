# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[semver](https://semver.org/).

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
