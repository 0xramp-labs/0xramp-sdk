# AGENTS.md — working rules for this repository

This is the **public** 0xramp SDK repository (`@0xramp-labs/0xramp-sdk`, npm
`@0xramp/sdk`). Anything committed here is public from the moment it is
pushed. The rules below are review gates: a PR that violates any of them is
rejected regardless of code quality.

## 1. Confidentiality fence (standing)

- Never copy code, fixtures, docs, or config from 0xramp's private
  repositories into this repo. **Re-derive from the public spec**
  (`docs/SPEC.md`, `docs/DESIGN.md`, `fixtures/`) instead.
- Never commit, paste, or reference: private source paths, internal endpoint
  inventories (beyond the public partner surface), ops/deployment internals,
  credentials, secret-shaped strings (keys, tokens, mnemonics), real user
  data, real addresses, or real QR payloads.
- Workbench/private notes (`engineering-plan.md`, `tmp/`) are gitignored and
  must never enter git history. If a private file ever gets committed, stop
  and escalate — do not "fix" it by deleting the file in a later commit.
- Agent sessions should read only the public docs (`docs/`, `README.md`,
  fixtures) unless explicitly handed private material by the owner in a
  private workspace.

## 2. Money-path invariants (review gates)

1. **The SDK never signs or moves funds.** No signing keys, no calldata
   building for money legs, no custody. The wallet signs only ZEC sends.
2. **Bridge results are advisory.** No code path may treat pane messages or
   return deep-links as authoritative for irreversible decisions. The
   authoritative partner-visible signal is the ticketed status endpoint.
3. **Integer money math only.** Canonical decimal strings / bigint. No JS
   `number` in any money path, ever. ZEC = 8-decimal units (zatoshi);
   fiat/USDC = 6-decimal units. All money values flow through `src/units/`.
4. **Fail closed.** Unknown envelope versions, schema violations, origin
   drift, session mismatch → abort/refuse/drop — never degrade silently.
5. **Origin lock.** Never hide the `0xramp.app` origin, never wrap it in a
   partner domain. Navigation helpers in `src/bridge/origin.ts` are the
   allowlist source.
6. **Corridors, limits, and catalogs are server-authoritative.** The SDK
   never caches, mirrors, or invents them; `buyLimit === 0` fails closed
   server-side. Fiat display amounts are receipt-only strings.
7. **Payout keys never cross the bridge.** No SDK type, log, or fixture may
   carry payout-key material.
8. **Attribution.** Public artifacts say **"Powered by 0xramp · P2P.me"**.
   Examples must render it.

## 3. Engineering conventions

- Strict `tsc --noEmit` is the static gate; CI runs it on Node 20 and 22.
- Tests are colocated (`*.test.ts` next to sources) and run with vitest.
- Fixtures-first: wire-format changes land as `fixtures/psp-v1/` vectors +
  schema changes in the same PR. The fixture suite is the conformance
  contract — the pane side validates against the same files.
- The core stays DOM-free and React-free (bridge transports are injected).
  Host-platform specifics live in `examples/` and partner code, not in `src/`.
- Pure ESM, no bundler for the library itself; `dist/` is `tsc` output.
- Dependencies are pinned exactly (`--save-exact`). Keep the core dependency
  footprint minimal; heavy platform SDKs may appear only as peer deps in
  later layers, never bundled.
- No ESLint for now; CI = typecheck + tests + audit + publish dry-run.
- Public API additions require a `CHANGELOG.md` entry in the same PR.

## 4. Protocol governance (PSP-v1)

- `src/protocol/` and `fixtures/` are wire-format surface: changes require
  CODEOWNERS approval.
- Versioning: `0.x` until the pilot completes; PSP-v1 freezes at `0.1.0`
  (additive-only afterward — new messages, new optional fields). Breaking
  changes mean a new envelope version (`psp/v2`), not mutations of v1.
- Release gate: version-bump PR + dated `CHANGELOG.md` entry + green CI +
  `npm publish --dry-run` clean, then publish with provenance from the tag.

## 5. Out of scope for v0 (do not build here)

Embedded Base/EVM signers · headless BUY/SELL orchestrators · fiat catalogs ·
payout-key handling · passkeys/identity outside `0xramp.app` · QR-PAY, swaps,
referrals, social verification · anything that would put signing keys or
custody in the SDK. Proposals to expand scope belong to the owner, not to an
agent session.

## 6. Environment discipline (install scripts & agent ops)

Library core is dependency-light. `examples/` (Electron, Expo, etc.) are
opt-in for partner testing, not CI.

- Routine verification (`npm run typecheck`, `npm test`, `npm run build`,
  `npm pack --dry-run`, `npm run audit`) must not install or run `examples/`.
- Install scripts are gated (`allowScripts`). Do not approve or bypass a
  lifecycle script in this repo without an explicit owner decision.
- Unexpected install/build failure: stop and report. No retry-loop.
