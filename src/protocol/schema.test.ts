/**
 * Schema fail-closed tests: malformed envelopes, unknown versions, shielded
 * addresses, non-canonical amounts — none may validate.
 */
import { describe, expect, it } from "vitest";

import {
  hasUnknownEnvelopeVersion,
  parseCreateSessionRequest,
  parseCreateSessionResponse,
  parseEnvelope,
  parsePaneToHostMessage,
  parseSessionStatus,
  transparentZcashAddressSchema,
  canonicalDecimalSchema,
} from "./schema.js";

const VALID_READY = {
  v: 1,
  type: "psp/ready",
  sessionRef: "sessGOLDEN00000001",
  payload: { sessionRef: "sessGOLDEN00000001", resolvedParams: {} },
};

describe("envelope validation", () => {
  it("accepts a valid envelope", () => {
    const res = parseEnvelope(VALID_READY);
    expect(res.ok).toBe(true);
  });

  it("rejects unknown envelope versions (fail closed)", () => {
    expect(hasUnknownEnvelopeVersion({ ...VALID_READY, v: 2 })).toBe(true);
    expect(hasUnknownEnvelopeVersion({ ...VALID_READY, v: 1 })).toBe(false);
    expect(hasUnknownEnvelopeVersion({ ...VALID_READY, v: "1" })).toBe(true);
    expect(hasUnknownEnvelopeVersion({})).toBe(false);
    expect(hasUnknownEnvelopeVersion(null)).toBe(false);
    const res = parsePaneToHostMessage({ ...VALID_READY, v: 2 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("UnsupportedProtocolVersion");
  });

  it("rejects schema violations", () => {
    const res = parsePaneToHostMessage({ ...VALID_READY, sessionRef: "short" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("SchemaViolation");
  });

  it("rejects missing version as schema violation (not version error)", () => {
    const { v: _v, ...withoutVersion } = VALID_READY;
    const res = parsePaneToHostMessage(withoutVersion);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("SchemaViolation");
  });

  it("rejects host→pane types arriving in the pane→host catalog", () => {
    const res = parsePaneToHostMessage({
      v: 1,
      type: "psp/zec-send-result",
      sessionRef: "sessGOLDEN00000001",
      payload: { requestId: "reqGOLDEN00000001", txid: "0".repeat(64) },
    });
    expect(res.ok).toBe(false);
  });
});

describe("address and amount formats", () => {
  it.each([
    "t1FakeAddrForFixtures9zqqqqqqqqqqqqq",
    "t3FakeAddrForFixtures9zqqqqqqqqqqqqq",
    "tmFakeAddrForFixtures9zqqqqqqqqqqqqq",
  ])("accepts transparent address %s", (addr) => {
    expect(transparentZcashAddressSchema.safeParse(addr).success).toBe(true);
  });

  it.each([
    "zs1shieldedaddressshouldfail000000000000000000000000000000000",
    "u1unifiedaddressshouldfail00000000000000000000000000000000000",
    "t1short",
    "bc1qnotzcash000000000000000000000000000000000000000",
  ])("rejects non-transparent address %s", (addr) => {
    expect(transparentZcashAddressSchema.safeParse(addr).success).toBe(false);
  });

  it.each(["0", "0.05", "12.5", "100"])("accepts canonical decimal %s", (value) => {
    expect(canonicalDecimalSchema.safeParse(value).success).toBe(true);
  });

  it.each([".5", "05", "1e3", "-1", "+1", "1.", "1,5", "", " 1"])("rejects non-canonical decimal %s", (value) => {
    expect(canonicalDecimalSchema.safeParse(value).success).toBe(false);
  });
});

describe("hosted API response schemas", () => {
  it("rejects non-https sessionUrl", () => {
    const res = parseCreateSessionResponse({
      sessionUrl: "http://0xramp.app/partner/x",
      sessionRef: "sessGOLDEN00000001",
      statusTicket: "v1.GOLDENFIXTUREwJk9mQ2sTvX7bN4rLp",
      expiresAt: "2026-09-21T12:00:00Z",
    });
    expect(res.ok).toBe(false);
  });

  it("rejects invalid lifecycle outcome in status", () => {
    const res = parseSessionStatus({
      outcome: "double-settled",
      updatedAt: "2026-09-21T12:00:00Z",
      terminal: true,
    });
    expect(res.ok).toBe(false);
  });

  it("rejects non-canonical create amount", () => {
    const res = parseCreateSessionRequest({
      partnerId: "zingo",
      direction: "sell",
      asset: "ZEC",
      fiat: "BRL",
      amount: "0.05000000e0",
    });
    expect(res.ok).toBe(false);
  });
});
