# Contributing

Thanks for looking under the hood. This SDK is small and contract-heavy —
read this before opening a PR.

## Ground rules

- **Money-path invariants are review gates.** Integer math only (canonical
  decimal strings / bigint — never JS numbers), fail closed on anything
  unexpected, never hide the `0xramp.app` origin, no signing / custody /
  payout-key handling, bridge results stay advisory. The full list is in
  [`AGENTS.md`](AGENTS.md) §2.
- **Wire-format changes** to `src/protocol/` or `fixtures/` require
  CODEOWNERS review and land as fixture vectors + schema changes in the same
  PR — the fixture suite is the cross-repo conformance contract.
- **PSP-v1 is additive-only** after freezing at `0.1.0`. A breaking change
  is a new envelope version, not a mutation of v1.
- **Public API additions need a `CHANGELOG.md` entry** in the same PR.

## Development

```bash
npm ci            # pinned dependencies
npm run typecheck # strict tsc, no emit
npm test          # vitest — includes golden-fixture parity
npm run build     # tsc → dist/ (ESM + .d.ts)
npm run audit     # runtime dependency audit
```

CI runs typecheck + tests + audit + publish dry-run on Node 20 and 22; a PR
is green only when all pass.

## Conventions

- Pure ESM. The core stays DOM-free and React-free — platform specifics live
  in `examples/`.
- Dependencies are pinned exactly (`--save-exact`); the runtime footprint is
  minimal (`zod` is the whole tree).
- Tests are colocated (`*.test.ts` next to sources) and run with vitest.
- No ESLint yet; strict `tsc` is the static gate.

## Bugs and security

Open a GitHub issue with a minimal reproduction, ideally against
`sandbox/sandbox-pane.html` or the golden fixtures. Security-sensitive
reports go through [SECURITY.md](SECURITY.md) — never a public issue.
