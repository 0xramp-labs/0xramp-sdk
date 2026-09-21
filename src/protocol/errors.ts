/**
 * Stable error taxonomy for the 0xramp SDK (PSP-v1).
 *
 * All SDK errors extend `PspError` and carry a machine-readable `code`
 * drawn from a small, additive-only enum. Hosts must branch on `code`,
 * never on message text.
 */

export type PspErrorCode =
  | "UnsupportedProtocolVersion"
  | "OriginLockViolation"
  | "SessionMismatch"
  | "SchemaViolation"
  | "PartnerQuotaExceeded"
  | "NetworkUnavailable"
  | "ApiError"
  | "InvalidAmount"
  | "InvalidReturnUrl"
  | "ConfigError";

export class PspError extends Error {
  readonly code: PspErrorCode;

  constructor(code: PspErrorCode, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The pane spoke an envelope version this SDK does not understand. Fail closed. */
export class UnsupportedProtocolVersionError extends PspError {
  constructor(message = "unsupported PSP envelope version") {
    super("UnsupportedProtocolVersion", message);
  }
}

/** WebView navigation left the allowed origin set. Fail closed. */
export class OriginLockViolationError extends PspError {
  constructor(message = "navigation or origin outside the 0xramp allowlist") {
    super("OriginLockViolation", message);
  }
}

/** A bridge message referenced a different session than the one attached. */
export class SessionMismatchError extends PspError {
  constructor(message = "bridge message sessionRef does not match the attached session") {
    super("SessionMismatch", message);
  }
}

/** A message or server response failed schema validation. */
export class SchemaViolationError extends PspError {
  constructor(message = "payload failed PSP schema validation") {
    super("SchemaViolation", message);
  }
}

/** The partner exceeded server-side quota/rate limits on the partner surface. */
export class PartnerQuotaExceededError extends PspError {
  constructor(message = "partner quota exceeded") {
    super("PartnerQuotaExceeded", message);
  }
}

/** The hosted API could not be reached, or the response was unusable. */
export class NetworkUnavailableError extends PspError {
  constructor(message = "0xramp hosted API unavailable") {
    super("NetworkUnavailable", message);
  }
}

/** The hosted API returned an unexpected non-2xx response. */
export class ApiError extends PspError {
  readonly status: number;

  constructor(status: number, message = "0xramp hosted API returned an error") {
    super("ApiError", message);
    this.status = status;
  }
}

/** A money value was not a canonical decimal / integer-unit string. */
export class InvalidAmountError extends PspError {
  constructor(message = "amount is not a canonical decimal string") {
    super("InvalidAmount", message);
  }
}

/** A return deep-link could not be parsed. */
export class InvalidReturnUrlError extends PspError {
  constructor(message = "return URL could not be parsed") {
    super("InvalidReturnUrl", message);
  }
}

/** Client configuration is invalid or incomplete. */
export class ConfigError extends PspError {
  constructor(message: string) {
    super("ConfigError", message);
  }
}
