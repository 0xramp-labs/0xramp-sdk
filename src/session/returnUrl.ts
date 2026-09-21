/**
 * Return deep-link parsing (PSP-v1 channel 5).
 *
 * Return URLs are **advisory UX resume signals only** — spoofable by design
 * (any app on the device can open the scheme). Hosts must never make money
 * decisions on them; reconcile via `getStatus` and your own Zcash chain view.
 */
import { InvalidReturnUrlError } from "../protocol/errors.js";
import type { SessionOutcome } from "../protocol/types.js";

export interface ParsedReturnUrl {
  /** Session reference if present and well-formed; null otherwise. */
  sessionRef: string | null;
  /** Terminal outcome if present and a known value; null otherwise. */
  outcome: SessionOutcome | null;
  /** True when the link claims a terminal outcome. Advisory only. */
  claimsTerminal: boolean;
  /** Raw query parameters (untrusted display data). */
  params: URLSearchParams;
}

const KNOWN_OUTCOMES: readonly SessionOutcome[] = ["settled", "failed", "expired", "cancelled"];
const MAX_RETURN_URL_LENGTH = 2048;

/**
 * Parse a return deep-link (e.g. `zingo://ramp?sessionRef=…&outcome=…`).
 * Never throws for missing fields — absent values are surfaced as `null`.
 * Throws `InvalidReturnUrlError` only for structurally unparseable input.
 */
export function parseReturnUrl(url: string): ParsedReturnUrl {
  if (url.length === 0 || url.length > MAX_RETURN_URL_LENGTH) {
    throw new InvalidReturnUrlError("return URL length out of bounds");
  }
  let params: URLSearchParams;
  try {
    const schemeSeparator = url.indexOf("://");
    if (schemeSeparator === -1) {
      // Custom schemes without `://` (e.g. `zingo:ramp?...`) — extract the query directly.
      const queryStart = url.indexOf("?");
      if (queryStart === -1) {
        params = new URLSearchParams();
      } else {
        params = new URLSearchParams(url.slice(queryStart + 1));
      }
    } else {
      params = new URLSearchParams(new URL(url, "https://0xramp.invalid").search);
    }
  } catch {
    throw new InvalidReturnUrlError("return URL could not be parsed");
  }

  const sessionRefRaw = params.get("sessionRef");
  const sessionRef = sessionRefRaw !== null && /^[A-Za-z0-9_-]{8,128}$/.test(sessionRefRaw) ? sessionRefRaw : null;

  const outcomeRaw = params.get("outcome");
  const outcome =
    outcomeRaw !== null && (KNOWN_OUTCOMES as readonly string[]).includes(outcomeRaw)
      ? (outcomeRaw as SessionOutcome)
      : null;

  return { sessionRef, outcome, claimsTerminal: outcome !== null, params };
}
