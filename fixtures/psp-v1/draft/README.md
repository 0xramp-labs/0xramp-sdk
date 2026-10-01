# PSP-v1 draft vectors — browser-hosted handoff (UNFROZEN)

**Status: DRAFT — unfrozen, pending partner confirmation.** These vectors
exercise the draft zec-send deep-link handoff codec (`src/session/handoff.ts`)
for the browser-hosted pane mode. They are **not** part of the PSP-v1 `0.1.0`
conformance set: this subdirectory is deliberately excluded from the frozen
golden-fixture loader (`src/protocol/fixtures.test.ts` reads only top-level
`*.json` files), `fixtures/psp-v1/manifest.json` does not list it, and
pane-side conformance is **not** claimed. The encoding may change before it
freezes; freezing waits on the partner's renamed return scheme and confirmed
wallet send API.

## Vector shape

Files are self-describing `{ kind, name, data }` objects, loaded and enforced
by `src/session/handoff.fixtures.test.ts`:

- `draft.zec-send-handoff` — pane → wallet handoff links.
  - Positive: `data: { url, expected }` — `parseZecSendHandoffUrl(url)` must
    deep-equal `expected` (`sessionRef` plus the `ZecSendRequestPayload`
    fields).
  - Negative: `data: { url, parse?, expected: { error } }` — parsing must
    throw the named PSP error code; the optional `parse.sessionRef` is passed
    as the expected-session argument.
- `draft.zec-send-resume` — wallet → pane resume URLs.
  - Positive: `data: { url, evidence, expected }` —
    `buildZecSendResumeUrl(url, evidence)` must equal the `expected` string.
    `txids` lists serialize comma-joined, percent-encoded as `%2C` by
    `URLSearchParams`; consumers parse with `URLSearchParams`.
  - Negative: `data: { url, evidence, expected: { error } }`.

## Draft encoding (reviewable, not frozen)

- Handoff link: dedicated query params on the host's registered scheme —
  `sessionRef`, `requestId`, `address` (transparent t-addr), `amountZat`
  (canonical integer zatoshi string), optional `memo` (≤ 512 chars).
- Resume link: an existing pane/return URL plus advisory evidence params
  `txid=<64-hex>` and/or `txids=<comma-separated 64-hex, 1–32>`.

Deep links are spoofable by design: handoff parses are payment *requests* for
the wallet's native confirmation sheet, and resume txids are advisory evidence
the pane reconciles — the ticketed status endpoint stays authoritative.

All values are synthetic. Real addresses, transaction IDs, or session data
must never be committed here.
