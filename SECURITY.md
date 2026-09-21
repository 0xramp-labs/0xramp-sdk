# Security Policy

## Reporting a vulnerability

**Do not open a public issue for anything security-sensitive.**

Report privately via GitHub's advisory channel:
[github.com/0xramp-labs/0xramp-sdk/security/advisories/new](https://github.com/0xramp-labs/0xramp-sdk/security/advisories/new)
(Security tab → *Report a vulnerability*).

Include reproduction steps, affected code paths, and an impact assessment
where possible. Reports are acknowledged within 72 hours; we coordinate
fixes and disclosure with reporters.

## Scope

**In scope**

- This repository: SDK source (`src/`), PSP-v1 schemas and golden fixtures
  (`fixtures/`), the sandbox pane, examples, and the documented integration
  contract (`docs/`).
- Reports concerning the hosted `0xramp.app` pane or partner API routed
  through the same private channel are welcome and will be forwarded.

**Out of scope**

- Third-party dependencies — report upstream, and tell us so we can bump the
  pinned version.
- Partner apps' own wallet code and key management.

## Trust invariants worth probing

The SDK is designed to fail closed: it never signs or moves funds, never
holds keys, never trusts client-declared completion for irreversible
decisions, and never accepts origin drift (`src/bridge/origin.ts` is the
allowlist source). Any code path that appears to violate these invariants is
a reportable finding — see [`docs/SPEC.md`](docs/SPEC.md) for the full
contract.
