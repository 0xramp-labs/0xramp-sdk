# Partner pilot readiness

This revision is intended for **partner development and simulated integration**.
It does not establish live API availability, Zingo device compatibility, funds
movement or successful fiat settlement. Keep the package's production warning
until the checks below have evidence.

## Recommended first pilot

One partner, one enabled corridor, SELL ZEC → BRL, a small operator-approved
amount and a native confirmation step. The public SDK remains host mode;
identity, provider eligibility, limits, quotes and fiat payout remain in the
0xramp pane. QR-PAY and a headless offramp are outside this version.

## Reproducible local verification

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:partner
npm run build
npm pack --dry-run --ignore-scripts
npm audit --omit=dev
```

`test:partner` is explicit opt-in, separate from routine CI. It tests the
same platform-independent host controller used by the RN example, with the
real SDK and synthetic API/wallet/storage/transport adapters. It does not
install or launch Expo, React Native or Electron.

| Covered in repository tests | Evidence boundary |
|---|---|
| Native JSON transport on window/document and browser object transport | Sandbox script, not a native WebView binary |
| New session replaces old bridge, close/unmount, late create response | Host-controller simulation |
| Duplicate requests, restart after broadcast, pending claims, storage failures | Durable-journal and bridge regression tests |
| Multiple transaction IDs and ambiguous broadcast failures | Synthetic wallet outputs |
| Exact custom origins, invalid ready binding, restored tickets, network deadlines | SDK unit tests |
| Advisory settlement/deep-link claims trigger ticketed status lookup | Mocked authoritative API |

## Required before enabling a live wallet adapter

- [ ] 0xramp issues the partner ID, exact API/pane origins and enabled corridor.
- [ ] `POST /api/partner/v0/sessions` returns a valid, loadable session; ticketed
  `GET /api/partner/v0/sessions/:sessionRef` works for that session. A homepage,
  OPTIONS response or local mock is insufficient.
- [ ] The deployed pane passes the shared PSP-v1 fixtures, including pending
  and multi-transaction results, and preserves request IDs across reconnects.
- [ ] Lost create responses have a server-supported reconciliation procedure;
  `partnerSessionId` alone is not an idempotency guarantee.
- [ ] Native adapter shows amount, destination and network fee, uses integer
  units, checks spendable balance, respects cancellation before signing and
  associates persisted requests with wallet history.
- [ ] Secure wallet-scoped journal/session storage survives process death.
  Cross-process claims are atomic; backup, reinstall, unavailable storage and
  large multi-transaction records have tested recovery behavior.
- [ ] The adapter preserves all returned transaction IDs and identifies the
  deposit transaction by its outputs. Unknown results never auto-resend.
- [ ] Real iOS and Android devices pass initial-load/redirect/popup origin
  locks, passkeys, foreground/background, registered return links and the
  agreed bank/browser handoff. Native fetch must refuse API redirects.
- [ ] A controlled real session proves both Zcash deposit and authoritative
  fiat settlement. Test failure, expiry/late deposit and interrupted return.
- [ ] Protocol/fixture CODEOWNERS approve this wire addition before merge.

The RN example deliberately returns `wallet adapter not configured` in live
mode. Fake transaction IDs are confined to the local sandbox. The Electron
example is local sandbox only; a production desktop host must use a top-level
pane rather than assume the hosted site permits iframes.

Never remove a pending journal entry or an expired session to bypass recovery.
No code change in this SDK alone can verify a partner's wallet signing adapter,
hosted passkeys, provider authorization or a bank payout.
