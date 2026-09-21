/**
 * Integer money math tests — canonical decimal string ↔ bigint round-trips
 * and strict rejection of anything float-shaped.
 */
import { describe, expect, it } from "vitest";

import {
  FIAT_DECIMALS,
  ZEC_DECIMALS,
  formatUnitsToDecimal,
  formatZatoshiAsAmountZat,
  formatZatoshiAsZec,
  isCanonicalDecimal,
  isCanonicalInteger,
  parseDecimalToUnits,
  parseFiatToUnits,
  parseZatoshi,
  parseZecToZatoshi,
} from "./decimal.js";

describe("parseDecimalToUnits", () => {
  it("parses canonical decimals into base units", () => {
    expect(parseDecimalToUnits("0.05", ZEC_DECIMALS)).toBe(5_000_000n);
    expect(parseDecimalToUnits("12.5", FIAT_DECIMALS)).toBe(12_500_000n);
    expect(parseDecimalToUnits("0", ZEC_DECIMALS)).toBe(0n);
    expect(parseDecimalToUnits("100", ZEC_DECIMALS)).toBe(100_000_000_00n);
  });

  it("rejects float-shaped and non-canonical input", () => {
    expect(() => parseDecimalToUnits(".5", ZEC_DECIMALS)).toThrow();
    expect(() => parseDecimalToUnits("05", ZEC_DECIMALS)).toThrow();
    expect(() => parseDecimalToUnits("1e3", ZEC_DECIMALS)).toThrow();
    expect(() => parseDecimalToUnits("-1", ZEC_DECIMALS)).toThrow();
    expect(() => parseDecimalToUnits("0.123456789", FIAT_DECIMALS)).toThrow();
  });

  it("never produces floats", () => {
    const units = parseDecimalToUnits("0.00000001", ZEC_DECIMALS);
    expect(typeof units).toBe("bigint");
    expect(units).toBe(1n);
  });
});

describe("formatUnitsToDecimal", () => {
  it("round-trips canonical decimals", () => {
    for (const value of ["0", "0.05", "12.5", "0.00000001", "100", "123456.789012"]) {
      const units = parseDecimalToUnits(value, ZEC_DECIMALS);
      expect(formatUnitsToDecimal(units, ZEC_DECIMALS)).toBe(
        formatUnitsToDecimal(parseDecimalToUnits(formatUnitsToDecimal(units, ZEC_DECIMALS), ZEC_DECIMALS), ZEC_DECIMALS),
      );
    }
  });

  it("formats canonical output (trims trailing zeros)", () => {
    expect(formatUnitsToDecimal(5_000_000n, ZEC_DECIMALS)).toBe("0.05");
    expect(formatUnitsToDecimal(0n, ZEC_DECIMALS)).toBe("0");
    expect(formatUnitsToDecimal(1n, ZEC_DECIMALS)).toBe("0.00000001");
    expect(formatUnitsToDecimal(12_500_000n, FIAT_DECIMALS)).toBe("12.5");
  });

  it("rejects negative units", () => {
    expect(() => formatUnitsToDecimal(-1n, ZEC_DECIMALS)).toThrow();
  });
});

describe("zatoshi helpers", () => {
  it("parses and formats amountZat integer strings", () => {
    expect(parseZatoshi("5000000")).toBe(5_000_000n);
    expect(() => parseZatoshi("0.5")).toThrow();
    expect(() => parseZatoshi("5e6")).toThrow();
    expect(formatZatoshiAsAmountZat(5_000_000n)).toBe("5000000");
    expect(formatZatoshiAsZec(5_000_000n)).toBe("0.05");
  });

  it("converts ZEC decimal strings to zatoshi", () => {
    expect(parseZecToZatoshi("0.05")).toBe(5_000_000n);
  });
});

describe("guards", () => {
  it("classifies canonical strings", () => {
    expect(isCanonicalDecimal("0.05")).toBe(true);
    expect(isCanonicalDecimal("1e3")).toBe(false);
    expect(isCanonicalInteger("5000000")).toBe(true);
    expect(isCanonicalInteger("5000000.0")).toBe(false);
  });

  it("parses fiat amounts at 6-decimal units", () => {
    expect(parseFiatToUnits("1234.56")).toBe(1_234_560_000n);
  });
});
