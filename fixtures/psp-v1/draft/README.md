# PSP-v1 draft vectors — browser-hosted handoff (UNFROZEN)

**Status: DRAFT — unfrozen, pending partner confirmation.** These vectors
exercise the draft zec-send deep-link handoff codec (`src/session/handoff.ts`)
for the browser-hosted pane mode. They are **not** part of the PSP-v1 `0.1.0`
conformance set: this subdirectory is deliberately excluded from the frozen
golden-fixture loader (`src/protocol/fixtures.test.ts` reads only top-level
`*.json` files), `fixtures/psp-v1/manifest.json` does not list it, and no
shared gate proves pane-side conformance, although the pane targets this
encoding. The encoding may change before it freezes; freezing waits on the partner's renamed return scheme and confirmed
wallet send API.

## Vector shape

Files are self-describing `{ kind, name, data }` objects, loaded and enforced
by `src/session/handoff.fixtures.test.ts`:

- `draft.zec-send-handoff` — pane → wallet handoff links.
  - Positive: `data: { url, parse, expected }` —
    `parseZecSendHandoffUrl(url, parse)` must deep-equal `expected`
    (`sessionRef` plus the `ZecSendRequestPayload` fields). Every vector
    binds a session: `parse.sessionRef` is required.
  - Negative: `data: { url, parse, expected: { error } }` — parsing must
    throw the named PSP error code; `parse.sessionRef` is passed as the
    expected-session argument.
- `draft.zec-send-resume` — wallet → pane resume URLs.
  - Positive: `data: { url, evidence, expected }` —
    `buildZecSendResumeUrl(url, evidence)` must equal the `expected` string.
    `txids` lists serialize comma-joined, percent-encoded as `%2C` by
    `URLSearchParams`; consumers parse with `URLSearchParams`.
  - Negative: `data: { url, evidence, expected: { error } }`.
- `draft.zec-send-recorded` — a handoff link checked against the request
  recorded for the session.
  - Positive: `data: { url, parse, recorded, expected }` — `matchZecSendHandoff`
    of the parsed link and `recorded` deep-equals `expected`.
  - Negative: `data: { url, parse, recorded, expected: { error, reason } }` — the
    match throws `HandoffRefused` with that `reason`.

## Draft encoding (reviewable, not frozen)

- Handoff link: dedicated query params on the host's registered scheme —
  `sessionRef`, `requestId`, `address` (transparent t-addr), `amountZat`
  (canonical integer zatoshi string), optional `memo` (≤ 512 chars). The pane
  uses the registered return URL itself as the base (no path segment added;
  SELL deposits carry no `memo`): `handoff.registered-base.json`. Parsing
  fails closed on duplicated query params, ignores a trailing `#fragment`,
  and requires the expected session to match.
- Resume link: the verbatim `sessionUrl` (query and `#paneToken` fragment
  intact — `resume.fragment.json`) plus advisory evidence params
  `txid=<64-hex>` and/or `txids=<comma-separated 64-hex, 1–32>`. The
  2048-character deep-link bound binds first: depending on the base URL,
  roughly 28–30 txids fit — larger evidence sets reconcile via the status
  endpoint. A `#fragment` on the base is preserved after the appended query.

- Recorded request: `GET …/sessions/:sessionRef/send-request` with the status
  ticket returns `{ "request": null }` until the pane records one, then
  `{ "request": { requestId, address, amountZat }, "deadline": <ISO 8601>,
  "state": <string> }`. `state` is the server's verdict: `sendable`, `answered` (a
  wallet reply is on record), `past-deadline` (at or within 30 s of the deadline)
  or `closed` (the route no longer accepts this deposit). Any other value must be
  read as not sendable.

Deep links are spoofable by design: a handoff parse is only a claim until it
matches the recorded request, the wallet's native confirmation sheet stays the
approval gate, and resume txids are advisory evidence the pane reconciles — the
ticketed status endpoint stays authoritative.

All values are synthetic. Real addresses, transaction IDs, or session data
must never be committed here.
