# Changelog

All notable changes to this project are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[semver](https://semver.org/).

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
