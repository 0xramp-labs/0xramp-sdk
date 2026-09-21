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

### Notes

- v0 scope: session opener, bridge, status reader. No signer, no orchestrator,
  no custody — the wallet signs only ZEC sends (SELL leg).
- "Powered by 0xramp · P2P.me" attribution is required in integrations.

[0.0.1]: https://github.com/0xramp-labs/0xramp-sdk/releases/tag/v0.0.1
