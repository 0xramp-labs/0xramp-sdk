/**
 * Integer money helpers — the only sanctioned way to touch amounts in SDK code.
 *
 * Rules inherited by every money path:
 * - canonical decimal strings / bigint only, never JS `number`;
 * - ZEC uses 8-decimal units (zatoshi); fiat/USDC legs use 6-decimal units;
 * - any float in a money path is a review-blocking bug.
 */
import { InvalidAmountError } from "../protocol/errors.js";

export const ZEC_DECIMALS = 8;
export const FIAT_DECIMALS = 6;
export const USDC_DECIMALS = 6;

const CANONICAL_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/;
const CANONICAL_INTEGER = /^(0|[1-9]\d*)$/;

/** True if `value` is a canonical decimal string (see `parseDecimalToUnits`). */
export function isCanonicalDecimal(value: string): boolean {
  return CANONICAL_DECIMAL.test(value);
}

/** True if `value` is a canonical integer string. */
export function isCanonicalInteger(value: string): boolean {
  return CANONICAL_INTEGER.test(value);
}

/**
 * Parse a canonical decimal string into integer base units.
 * Throws `InvalidAmountError` (never returns NaN, never touches floats) when
 * the string is not canonical or has more than `decimals` fraction digits.
 */
export function parseDecimalToUnits(value: string, decimals: number): bigint {
  if (!isCanonicalDecimal(value)) {
    throw new InvalidAmountError(`amount is not a canonical decimal string: ${describe(value)}`);
  }
  const dot = value.indexOf(".");
  const intPart = dot === -1 ? value : value.slice(0, dot);
  const fracPart = dot === -1 ? "" : value.slice(dot + 1);
  if (fracPart.length > decimals) {
    throw new InvalidAmountError(`amount has more than ${decimals} fraction digits: ${describe(value)}`);
  }
  const paddedFrac = fracPart.padEnd(decimals, "0");
  const combined = decimals === 0 ? intPart : `${intPart}${paddedFrac}`;
  return BigInt(combined);
}

/**
 * Format integer base units as a canonical decimal string with `decimals`
 * fraction places available; trailing zeros are trimmed, `"0"` for zero.
 */
export function formatUnitsToDecimal(units: bigint, decimals: number): string {
  if (units < 0n) {
    throw new InvalidAmountError("negative amounts are not representable");
  }
  const digits = units.toString();
  if (decimals === 0 || units === 0n) {
    return units === 0n ? "0" : digits;
  }
  if (digits.length <= decimals) {
    const frac = digits.padStart(decimals, "0").replace(/0+$/, "");
    return frac === "" ? "0" : `0.${frac}`;
  }
  const intPart = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return frac === "" ? intPart : `${intPart}.${frac}`;
}

/** Parse a zatoshi integer string (10⁻⁸ ZEC) into bigint zatoshi. */
export function parseZatoshi(amountZat: string): bigint {
  if (!isCanonicalInteger(amountZat)) {
    throw new InvalidAmountError(`amountZat is not a canonical integer string: ${describe(amountZat)}`);
  }
  return BigInt(amountZat);
}

/** Parse a ZEC decimal string into bigint zatoshi. */
export function parseZecToZatoshi(amountZec: string): bigint {
  return parseDecimalToUnits(amountZec, ZEC_DECIMALS);
}

/** Format bigint zatoshi as a canonical ZEC decimal string. */
export function formatZatoshiAsZec(zatoshi: bigint): string {
  return formatUnitsToDecimal(zatoshi, ZEC_DECIMALS);
}

/** Format bigint zatoshi as its canonical integer-unit wire string (`amountZat`). */
export function formatZatoshiAsAmountZat(zatoshi: bigint): string {
  if (zatoshi < 0n) {
    throw new InvalidAmountError("negative amounts are not representable");
  }
  return zatoshi.toString();
}

/** Parse a fiat/USDC decimal string (6-decimal units) into bigint base units. */
export function parseFiatToUnits(amount: string): bigint {
  return parseDecimalToUnits(amount, FIAT_DECIMALS);
}

function describe(value: string): string {
  const truncated = value.length > 24 ? `${value.slice(0, 24)}…` : value;
  return `"${truncated.replace(/[^0-9.]/g, "�")}"`;
}
