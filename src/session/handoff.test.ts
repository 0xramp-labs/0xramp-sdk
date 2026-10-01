/**
 * Draft zec-send handoff codec — parse/build behavior and fail-closed gates.
 * All values are sandbox-style synthetic; nothing here is real address,
 * amount, or transaction data.
 */
import { describe, expect, it } from "vitest";

import {
  ConfigError,
  InvalidAmountError,
  InvalidReturnUrlError,
  SchemaViolationError,
  SessionMismatchError,
} from "../protocol/errors.js";
import { createMemoryZecSendStore, sendReply } from "../bridge/sendStore.js";
import { parseReturnUrl } from "./returnUrl.js";
import {
  buildZecSendResumeUrl,
  parseZecSendHandoffUrl,
  type ZecSendResumeEvidence,
} from "./handoff.js";

const SESSION_REF = "sessGOLDEN00000001";
const REQUEST_ID = "reqGOLDEN00000001";
const ADDRESS = "t1FakeAddrForFixtures9zqqqqqqqqqqqqq";
const AMOUNT_ZAT = "5000000";
const TXID = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const TXID_2 = "010102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const CANONICAL_HANDOFF =
  `zramp://send?sessionRef=${SESSION_REF}&requestId=${REQUEST_ID}` +
  `&address=${ADDRESS}&amountZat=${AMOUNT_ZAT}`;

describe("parseZecSendHandoffUrl", () => {
  it("parses the canonical draft handoff link", () => {
    expect(parseZecSendHandoffUrl(CANONICAL_HANDOFF)).toEqual({
      sessionRef: SESSION_REF,
      requestId: REQUEST_ID,
      address: ADDRESS,
      amountZat: AMOUNT_ZAT,
    });
  });

  it("omits the memo key when the link carries none", () => {
    expect(parseZecSendHandoffUrl(CANONICAL_HANDOFF)).not.toHaveProperty("memo");
  });

  it("matches an expected sessionRef", () => {
    expect(parseZecSendHandoffUrl(CANONICAL_HANDOFF, { sessionRef: SESSION_REF }).requestId).toBe(REQUEST_ID);
  });

  it("parses schemes without // (consistent with parseReturnUrl)", () => {
    const parsed = parseZecSendHandoffUrl(`zramp:send?sessionRef=${SESSION_REF}&requestId=${REQUEST_ID}&address=${ADDRESS}&amountZat=${AMOUNT_ZAT}`);
    expect(parsed.address).toBe(ADDRESS);
  });

  it("decodes an optional memo", () => {
    const parsed = parseZecSendHandoffUrl(`${CANONICAL_HANDOFF}&memo=Deposit%20fee`);
    expect(parsed.memo).toBe("Deposit fee");
  });

  it("throws SessionMismatch for a link of another session", () => {
    expect(() => parseZecSendHandoffUrl(CANONICAL_HANDOFF, { sessionRef: "sessOTHER000000001" })).toThrow(
      SessionMismatchError,
    );
  });

  it.each([
    ["missing sessionRef", "zramp://send?requestId=reqGOLDEN00000001&address=t1FakeAddrForFixtures9zqqqqqqqqqqqqq&amountZat=5000000"],
    ["malformed sessionRef", "zramp://send?sessionRef=<script>&requestId=reqGOLDEN00000001&address=t1FakeAddrForFixtures9zqqqqqqqqqqqqq&amountZat=5000000"],
    ["missing requestId", `zramp://send?sessionRef=${SESSION_REF}&address=${ADDRESS}&amountZat=${AMOUNT_ZAT}`],
    ["malformed requestId", `zramp://send?sessionRef=${SESSION_REF}&requestId=x&address=${ADDRESS}&amountZat=${AMOUNT_ZAT}`],
    ["shielded address", `zramp://send?sessionRef=${SESSION_REF}&requestId=${REQUEST_ID}&address=zs1vulnerable&amountZat=${AMOUNT_ZAT}`],
    ["memo over 512 chars", `${CANONICAL_HANDOFF}&memo=${"m".repeat(513)}`],
  ])("fails closed on %s", (_name, url) => {
    expect(() => parseZecSendHandoffUrl(url)).toThrow(SchemaViolationError);
  });

  it.each(["5.5", "-5", "05", "1e3", ""])("fails closed on non-canonical amountZat %s", amountZat => {
    const url = `zramp://send?sessionRef=${SESSION_REF}&requestId=${REQUEST_ID}&address=${ADDRESS}&amountZat=${amountZat}`;
    expect(() => parseZecSendHandoffUrl(url)).toThrow(InvalidAmountError);
  });

  it.each(["", `zramp://send?x=${"a".repeat(3000)}`])("throws InvalidReturnUrl for unparseable/oversized input", url => {
    expect(() => parseZecSendHandoffUrl(url)).toThrow(InvalidReturnUrlError);
  });

  it("feeds the existing ZecSendStore claim/journal semantics unchanged", async () => {
    const parsed = parseZecSendHandoffUrl(CANONICAL_HANDOFF, { sessionRef: SESSION_REF });
    const { sessionRef: _sessionRef, ...request } = parsed; // the journal stores the payload; sessionRef keys the record
    const store = createMemoryZecSendStore();
    expect(await store.claim(parsed.sessionRef, request)).toBeUndefined();
    const replay = await store.claim(parsed.sessionRef, request);
    expect(replay?.request).toEqual(request);
    await store.complete(parsed.sessionRef, request, sendReply(parsed.sessionRef, parsed.requestId, { txid: TXID }));
    const journaled = await store.claim(parsed.sessionRef, request);
    expect(journaled?.reply?.type).toBe("psp/zec-send-result");
  });
});

describe("buildZecSendResumeUrl", () => {
  const PANE_URL = "https://0xramp.app/partner/zingo?sessionRef=sessGOLDEN00000001";

  it("appends a single advisory txid to a pane URL", () => {
    expect(buildZecSendResumeUrl(PANE_URL, { txid: TXID })).toBe(`${PANE_URL}&txid=${TXID}`);
  });

  it("appends comma-joined txids without a txid param (pending-style evidence)", () => {
    const resume = buildZecSendResumeUrl(PANE_URL, { txids: [TXID, TXID_2] });
    expect(resume).toBe(`${PANE_URL}&txids=${TXID}%2C${TXID_2}`);
  });

  it("appends both params when txids includes the deposit txid", () => {
    const resume = buildZecSendResumeUrl(PANE_URL, { txid: TXID, txids: [TXID, TXID_2] });
    expect(resume).toBe(`${PANE_URL}&txid=${TXID}&txids=${TXID}%2C${TXID_2}`);
  });

  it("works on scheme-without-// bases, preserving existing params", () => {
    expect(buildZecSendResumeUrl(`zramp:ramp?sessionRef=${SESSION_REF}`, { txid: TXID })).toBe(
      `zramp:ramp?sessionRef=${SESSION_REF}&txid=${TXID}`,
    );
  });

  it("round-trips through the existing channel-5 parser (sessionRef intact)", () => {
    const resume = buildZecSendResumeUrl(PANE_URL, { txid: TXID });
    expect(parseReturnUrl(resume)).toMatchObject({ sessionRef: SESSION_REF, claimsTerminal: false });
  });

  it.each([
    ["txids omitting the deposit txid", PANE_URL, { txid: TXID, txids: [TXID_2] }],
    ["33 txids", PANE_URL, { txids: Array.from({ length: 33 }, () => TXID) }],
    ["non-hex txid", PANE_URL, { txid: "nothex" }],
    ["non-hex txids entry", PANE_URL, { txids: [TXID, "xyz"] }],
    ["base already carrying txid", `${PANE_URL}&txid=${TXID}`, { txid: TXID_2 }],
  ] as [string, string, ZecSendResumeEvidence][])("fails closed on %s", (_name, base, evidence) => {
    expect(() => buildZecSendResumeUrl(base, evidence)).toThrow(SchemaViolationError);
  });

  it("fails closed on empty evidence", () => {
    expect(() => buildZecSendResumeUrl(PANE_URL, {})).toThrow(ConfigError);
    expect(() => buildZecSendResumeUrl(PANE_URL, { txids: [] })).toThrow(ConfigError);
  });

  it("fails closed on an unparseable base", () => {
    expect(() => buildZecSendResumeUrl("https://", { txid: TXID })).toThrow(InvalidReturnUrlError);
  });

  it("fails closed when the evidence cannot fit the deep-link bound", () => {
    expect(() => buildZecSendResumeUrl("https://0xramp.app/x", { txids: Array.from({ length: 32 }, () => TXID) })).toThrow(
      InvalidReturnUrlError,
    );
  });
});
