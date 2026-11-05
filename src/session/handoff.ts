/**
 * ZEC-send deep-link handoff codec (browser-hosted pane mode).
 *
 * **DRAFT — unfrozen, pending partner confirmation.** The wallet's renamed
 * return scheme and its native send API are not confirmed yet, so the
 * query-param encoding below is a reviewable draft: it is NOT part of the
 * PSP-v1 conformance set, no shared gate proves pane-side conformance although
 * the pane targets this encoding, and the encoding may change before it
 * freezes. Draft vectors live in
 * `fixtures/psp-v1/draft/`, which the frozen fixture gate does not load.
 *
 * Draft encoding (dedicated query params on the host's registered scheme):
 * - pane → wallet handoff link, with the registered return URL itself as the
 *   base (no path segment added; SELL deposits carry no memo):
 *   `<returnUrl>?sessionRef=…&requestId=…&address=<t-addr>&amountZat=<integer>[&memo=…]`
 * - wallet → pane resume link: the verbatim `sessionUrl` (query and
 *   `#paneToken` fragment intact) plus advisory txid evidence params
 *   `txid=<64-hex>` and/or `txids=<comma-separated 64-hex>`.
 *
 * Trust model: deep links are spoofable by design, so a parsed handoff proves
 * nothing by itself. `matchZecSendHandoff` compares it with the request 0xramp
 * recorded for the session, read with the status ticket the pane never holds,
 * and takes the server's verdict on whether it can still be sent. Only a matching,
 * sendable request may reach the wallet's native confirmation sheet, which stays
 * the approval gate — the SDK never signs. Resume-link txids
 * are advisory evidence for the pane to reconcile; the ticketed status endpoint
 * stays authoritative. The parse output is shape-compatible with
 * `ZecSendRequestPayload`, so the existing `ZecSendStore` claim/journal
 * semantics (exactly-once, replay-safe) apply unchanged.
 *
 * DOM-free and React-free: only WHATWG URL/URLSearchParams, the shared
 * protocol schemas, and the integer money helpers are used.
 */
import { z } from "zod";

import {
  ConfigError,
  InvalidReturnUrlError,
  SchemaViolationError,
  SessionMismatchError,
  ZecSendHandoffRefusedError,
} from "../protocol/errors.js";
import {
  parsePaneToHostMessage,
  sessionRefSchema,
  zecTxidSchema,
  type ParseResult,
} from "../protocol/schema.js";
import type { ZecSendRequestPayload } from "../protocol/types.js";
import { parseZatoshi } from "../units/decimal.js";

/** Same practical deep-link bound as return URLs (see `parseReturnUrl`). */
const MAX_HANDOFF_URL_LENGTH = 2048;

/** Query parameters the handoff codec consumes; each may appear at most once. */
const HANDOFF_PARAMS = ["sessionRef", "requestId", "address", "amountZat", "memo"] as const;

/**
 * Query extraction mirroring `parseReturnUrl`: custom schemes may appear with
 * or without `//`. A trailing `#fragment` is never part of the query.
 */
function handoffQueryParams(url: string): URLSearchParams {
  const fragmentStart = url.indexOf("#");
  const withoutFragment = fragmentStart === -1 ? url : url.slice(0, fragmentStart);
  const schemeSeparator = withoutFragment.indexOf("://");
  if (schemeSeparator === -1) {
    const queryStart = withoutFragment.indexOf("?");
    return new URLSearchParams(queryStart === -1 ? "" : withoutFragment.slice(queryStart + 1));
  }
  return new URLSearchParams(new URL(withoutFragment, "https://0xramp.invalid").search);
}

/**
 * **DRAFT — unfrozen, pending partner confirmation.** Canonical parse
 * result: `sessionRef` plus a `ZecSendRequestPayload`-shaped request. This is an
 * unverified claim: only the `request` returned by `verifyZecSendHandoff` may
 * reach `ZecSendStore.claim` and the native sheet.
 */
export type ParsedZecSendHandoff = ZecSendRequestPayload & { sessionRef: string };

/**
 * **DRAFT — unfrozen, pending partner confirmation.** Parse a pane → wallet
 * handoff link carrying the payment request (session/request correlation ID,
 * transparent deposit address, exact integer zatoshi amount, optional memo).
 *
 * `expected.sessionRef` is **required**: a link from any other session throws
 * `SessionMismatchError`, so a well-formed link can never be accepted without
 * binding it to the host's session.
 *
 * Fail closed: missing/malformed parameters throw `SchemaViolationError`
 * (including any query parameter appearing more than once), non-canonical
 * amounts throw `InvalidAmountError`, unparseable input throws
 * `InvalidReturnUrlError`, and a link for a different session throws
 * `SessionMismatchError`. A link that parses is still only a claim, and any app
 * can open the scheme: hosts call `verifyZecSendHandoff` before their journal and
 * their native sheet, which remains the approval gate. This function never signs
 * and never moves funds.
 */
export function parseZecSendHandoffUrl(
  url: string,
  expected: { sessionRef: string },
): ParsedZecSendHandoff {
  if (url.length === 0 || url.length > MAX_HANDOFF_URL_LENGTH) {
    throw new InvalidReturnUrlError("handoff URL length out of bounds");
  }
  let params: URLSearchParams;
  try {
    params = handoffQueryParams(url);
  } catch {
    throw new InvalidReturnUrlError("handoff URL could not be parsed");
  }
  for (const key of HANDOFF_PARAMS) {
    if (params.getAll(key).length > 1) {
      throw new SchemaViolationError("handoff link carries duplicate parameters");
    }
  }

  const sessionRef = params.get("sessionRef");
  if (sessionRef === null || !sessionRefSchema.safeParse(sessionRef).success) {
    throw new SchemaViolationError("handoff link carries no well-formed sessionRef");
  }
  if (sessionRef !== expected.sessionRef) {
    throw new SessionMismatchError("handoff link belongs to a different session");
  }

  const requestId = params.get("requestId");
  const address = params.get("address");
  const amountZat = params.get("amountZat");
  if (requestId === null || address === null || amountZat === null) {
    throw new SchemaViolationError("handoff link is missing required payment parameters");
  }
  // Integer money path: canonical zatoshi or `InvalidAmountError`.
  parseZatoshi(amountZat);

  const memo = params.get("memo");
  const payload: ZecSendRequestPayload = {
    requestId,
    address,
    amountZat,
    ...(memo !== null ? { memo } : {}),
  };
  // Same schema gate the bridge applies to pane `psp/zec-send-request` payloads.
  const checked = parsePaneToHostMessage({ v: 1, type: "psp/zec-send-request", sessionRef, payload });
  if (!checked.ok) throw checked.error;
  if (checked.value.type !== "psp/zec-send-request") {
    throw new SchemaViolationError("unexpected handoff message type");
  }
  return { sessionRef, ...payload };
}

/**
 * **DRAFT — unfrozen, pending partner confirmation.** The send request 0xramp
 * recorded for a session, as returned by the ticketed read. `state` is the
 * server's verdict, on its own clock and financial session: `sendable`,
 * `answered` (a wallet reply is on record), `past-deadline` (at or within 30 s of
 * the deadline) or `closed` (the route no longer accepts this deposit). Any other
 * value must be read as not sendable.
 */
export type RecordedZecSendRequest =
  | { request: null }
  | { request: ZecSendRequestPayload; deadline: string; state: string };

/** **DRAFT.** A handoff that matched the record while the server called it sendable. */
export interface VerifiedZecSendHandoff {
  sessionRef: string;
  /** What may reach `ZecSendStore.claim` and the native sheet. */
  request: ZecSendRequestPayload;
  /** ISO 8601. Bound the native sheet by it: status will not end a recorded request. */
  deadline: string;
}

const recordedResponseSchema = z.object({
  request: z.unknown(),
  deadline: z.string().max(64).refine((value) => Number.isFinite(Date.parse(value))).optional(),
  state: z.string().min(1).max(32).optional(),
});

/** **DRAFT.** Validate the ticketed read through the same payload gate the bridge applies. */
export function parseRecordedZecSendRequest(raw: unknown, sessionRef: string): ParseResult<RecordedZecSendRequest> {
  const refused = (message: string) => ({ ok: false as const, error: new SchemaViolationError(message) });
  const body = recordedResponseSchema.safeParse(raw);
  if (!body.success || body.data.request === undefined) return refused("recorded send request failed schema validation");
  if (body.data.request === null) return { ok: true, value: { request: null } };
  const { deadline, state } = body.data;
  if (deadline === undefined || state === undefined) return refused("recorded send request is incomplete");
  const checked = parsePaneToHostMessage({ v: 1, type: "psp/zec-send-request", sessionRef, payload: body.data.request });
  if (!checked.ok) return checked;
  if (checked.value.type !== "psp/zec-send-request") return refused("unexpected recorded request type");
  return { ok: true, value: { request: checked.value.payload, deadline, state } };
}

/**
 * **DRAFT.** Refuse a parsed handoff unless it is exactly the recorded request and
 * the server calls it sendable. Exact string comparison on canonical values:
 * address, integer amount, request id, and a memo only if recorded. An unknown or
 * missing state is refused: only `sendable` opens the way.
 */
export function matchZecSendHandoff(handoff: ParsedZecSendHandoff, recorded: RecordedZecSendRequest): VerifiedZecSendHandoff {
  if (recorded.request === null || recorded.request === undefined) throw new ZecSendHandoffRefusedError("not-recorded");
  const { request } = recorded;
  if (
    request.requestId !== handoff.requestId ||
    request.address !== handoff.address ||
    request.amountZat !== handoff.amountZat ||
    (request.memo ?? null) !== (handoff.memo ?? null)
  ) {
    throw new ZecSendHandoffRefusedError("mismatch");
  }
  if (recorded.state === "sendable") return { sessionRef: handoff.sessionRef, request, deadline: recorded.deadline };
  if (recorded.state === "answered" || recorded.state === "past-deadline") throw new ZecSendHandoffRefusedError(recorded.state);
  throw new ZecSendHandoffRefusedError("closed");
}

/**
 * **DRAFT — unfrozen, pending partner confirmation.** Advisory txid evidence
 * a wallet attaches to a wallet → pane resume link after a native confirm +
 * broadcast. Either field alone is valid; providing both requires `txids` to
 * include `txid` (matching the `psp/zec-send-result` wire constraint).
 */
export interface ZecSendResumeEvidence {
  /** Identified deposit transaction (result-style evidence). */
  txid?: string;
  /** 1–32 related transaction IDs (pending-style or full evidence list). */
  txids?: string[];
}

/**
 * **DRAFT — unfrozen, pending partner confirmation.** Build a wallet → pane
 * resume URL: the verbatim `sessionUrl` (its query and `#paneToken` fragment
 * are preserved — the pane cannot open without the fragment) plus advisory
 * txid evidence as `txid` / comma-joined `txids` query params. Pure string
 * building — the outcome is evidence for the pane to reconcile, never an
 * authoritative receipt; the pane's own chain view and the status endpoint
 * decide.
 *
 * Fail closed on an unparseable base (`InvalidReturnUrlError`), missing
 * evidence (`ConfigError`), schema-violating values (`SchemaViolationError`),
 * or output beyond the 2048-character deep-link bound (`InvalidReturnUrlError`).
 * The 2048-character bound binds first: depending on the base URL, roughly
 * 28–30 txids fit; reconcile larger evidence sets via the status endpoint.
 */
export function buildZecSendResumeUrl(baseUrl: string, evidence: ZecSendResumeEvidence): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new InvalidReturnUrlError("resume base URL could not be parsed");
  }
  if (parsed.searchParams.has("txid") || parsed.searchParams.has("txids")) {
    throw new SchemaViolationError("resume base URL already carries txid evidence");
  }

  const { txid, txids } = evidence;
  if (txid === undefined && (txids === undefined || txids.length === 0)) {
    throw new ConfigError("resume evidence requires txid, txids, or both");
  }
  if (txid !== undefined && !zecTxidSchema.safeParse(txid).success) {
    throw new SchemaViolationError("resume txid is not a 64-hex transaction id");
  }
  if (txids !== undefined) {
    if (txids.length < 1 || txids.length > 32 || !txids.every(id => zecTxidSchema.safeParse(id).success)) {
      throw new SchemaViolationError("resume txids must be 1–32 64-hex transaction ids");
    }
    if (txid !== undefined && !txids.includes(txid)) {
      throw new SchemaViolationError("resume txids must include the deposit txid");
    }
  }

  // Spliced by hand, on values already proven hex: React Native's own URL class
  // appends mutated params after the fragment, where the pane cannot read them.
  const added = [
    ...(txid !== undefined ? [`txid=${txid}`] : []),
    ...(txids !== undefined ? [`txids=${txids.join("%2C")}`] : []),
  ].join("&");
  const fragmentAt = baseUrl.indexOf("#");
  const head = fragmentAt === -1 ? baseUrl : baseUrl.slice(0, fragmentAt);
  const fragment = fragmentAt === -1 ? "" : baseUrl.slice(fragmentAt);
  const separator = !head.includes("?") ? "?" : /[?&]$/.test(head) ? "" : "&";
  const resume = `${head}${separator}${added}${fragment}`;
  if (resume.length > MAX_HANDOFF_URL_LENGTH) {
    throw new InvalidReturnUrlError(
      "resume URL exceeds the 2048-character deep-link bound; reconcile large evidence sets via the status endpoint",
    );
  }
  return resume;
}
