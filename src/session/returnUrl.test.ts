/**
 * Return deep-link parsing — advisory-only channel 5.
 */
import { describe, expect, it } from "vitest";

import { parseReturnUrl } from "./returnUrl.js";

describe("parseReturnUrl", () => {
  it("parses the canonical vector", () => {
    const parsed = parseReturnUrl("zingo://ramp?sessionRef=sessGOLDEN00000001&outcome=settled");
    expect(parsed.sessionRef).toBe("sessGOLDEN00000001");
    expect(parsed.outcome).toBe("settled");
    expect(parsed.claimsTerminal).toBe(true);
  });

  it("parses custom schemes without ://", () => {
    const parsed = parseReturnUrl("zingo:ramp?sessionRef=sessGOLDEN00000001&outcome=failed");
    expect(parsed.sessionRef).toBe("sessGOLDEN00000001");
    expect(parsed.outcome).toBe("failed");
  });

  it("returns nulls for absent/unknown fields", () => {
    const parsed = parseReturnUrl("zingo://ramp?foo=bar");
    expect(parsed.sessionRef).toBeNull();
    expect(parsed.outcome).toBeNull();
    expect(parsed.claimsTerminal).toBe(false);
  });

  it("ignores malformed sessionRef and unknown outcomes (never throws)", () => {
    const parsed = parseReturnUrl("zingo://ramp?sessionRef=<script>&outcome=double-settled");
    expect(parsed.sessionRef).toBeNull();
    expect(parsed.outcome).toBeNull();
  });

  it("throws InvalidReturnUrl for unparseable input", () => {
    expect(() => parseReturnUrl("")).toThrow();
    expect(() => parseReturnUrl(`zingo://ramp?x=${"a".repeat(3000)}`)).toThrow();
  });
});
